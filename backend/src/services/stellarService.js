/**
 * stellarService.js
 *
 * Core Stellar operations:
 *   - Create campaign wallets (multisig)
 *   - Establish trustlines
 *   - Build and submit contribution transactions
 *   - Path payment (cross-currency contributions)
 */

const {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
} = require('@stellar/stellar-sdk');
const {
  server,
  networkPassphrase,
  USDC,
  isTestnet,
  configuredAssets,
} = require('../config/stellar');
const Sentry = require("@sentry/node");
const {
  TX_TIMEOUT_CONTRIBUTION_S,
  TX_TIMEOUT_WITHDRAWAL_S,
  CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM,
  CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM,
} = require("../config/constants");

const PLATFORM_KEYPAIR = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);

function calcFee(amount) {
  const bps = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);
  const fee = parseFloat((parseFloat(amount) * bps / 10000).toFixed(7));
  const net = parseFloat((parseFloat(amount) - fee).toFixed(7));
  return { feeAmount: fee, campaignAmount: net, bps };
}

function toStellarAsset(assetCode) {
  if (assetCode === 'XLM') return Asset.native();
  if (assetCode === 'USDC') return USDC;
  if (configuredAssets[assetCode]?.issuer) {
    return new Asset(assetCode, configuredAssets[assetCode].issuer);
  }
  throw new Error(`Unsupported asset: ${assetCode}`);
}

function getSupportedAssetCodes() {
  return Object.keys(configuredAssets);
}

/** Issued assets CrowdPay may move on-chain (requires trustlines on custodial accounts). */
function listCreditAssetCodes() {
  return getSupportedAssetCodes().filter((code) => code !== 'XLM');
}

function accountHasCreditTrustline(account, assetCode) {
  if (assetCode === 'XLM') return true;
  const asset = toStellarAsset(assetCode);
  return account.balances.some(
    (b) =>
      b.asset_type !== 'native' &&
      b.asset_code === asset.code &&
      b.asset_issuer === asset.issuer
  );
}

/** Minimum starting XLM for a new account that will hold `trustlineCount` trust lines (approximate). */
function suggestedFundingXlmForCustodialAccount(trustlineCount) {
  return (
    CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM +
    Math.max(0, trustlineCount) * CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM
  ).toFixed(7);
}

async function accountExistsOnLedger(publicKey) {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) return false;
    if (err?.response?.data?.status === 404) return false;
    throw err;
  }
}

/**
 * Create and fund a custodial account on the ledger (platform pays createAccount fee + reserve).
 * No-op if the account already exists.
 */
async function fundCustodialAccountFromPlatformIfNeeded(publicKey) {
  if (await accountExistsOnLedger(publicKey)) return false;
  const trustlineCount = listCreditAssetCodes().length;
  const startingBalance = suggestedFundingXlmForCustodialAccount(trustlineCount);
  const platformAccount = await server.loadAccount(PLATFORM_KEYPAIR.publicKey());
  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: publicKey,
        startingBalance,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(PLATFORM_KEYPAIR);
  await server.submitTransaction(tx);
  return true;
}

/**
 * Add missing trustlines for all configured credit assets; signed by the custodial account master.
 * Returns the last transaction hash if a transaction was submitted, otherwise null.
 */
async function submitMissingTrustlinesForCustodialAccount(signerSecret) {
  const keypair = Keypair.fromSecret(signerSecret);
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  let missing = 0;
  for (const code of listCreditAssetCodes()) {
    if (!accountHasCreditTrustline(account, code)) {
      builder.addOperation(Operation.changeTrust({ asset: toStellarAsset(code) }));
      missing += 1;
    }
  }

  if (!missing) return null;

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Ensure a custodial user (or any funded keypair we hold) can hold and send all supported issued assets.
 * Creates the ledger account via platform if missing, then establishes any missing trustlines.
 */
async function ensureCustodialAccountFundedAndTrusted({ publicKey, secret }) {
  await fundCustodialAccountFromPlatformIfNeeded(publicKey);
  return submitMissingTrustlinesForCustodialAccount(secret);
}

function normalizeAsset(record) {
  if (!record) return null;
  if (record.asset_type === 'native') return 'XLM';
  return record.asset_code;
}

/**
 * Create a new Stellar account for a campaign.
 * The platform funds the minimum reserve (1 XLM on testnet).
 * Both the creator's key and the platform key are added as signers.
 * Medium threshold is set to 2 — both must sign to move funds.
 */
async function createCampaignWallet(creatorPublicKey) {
  const campaignKeypair = Keypair.random();
  const platformAccount = await server.loadAccount(PLATFORM_KEYPAIR.publicKey());

  const creditCodes = listCreditAssetCodes();
  const campaignStartingBalance = suggestedFundingXlmForCustodialAccount(creditCodes.length + 1);

  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createAccount({
        destination: campaignKeypair.publicKey(),
        startingBalance: campaignStartingBalance,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(PLATFORM_KEYPAIR);
  await server.submitTransaction(tx);

  // Now configure the campaign account: trustline + multisig
  const campaignAccount = await server.loadAccount(campaignKeypair.publicKey());

  const setupBuilder = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });
  for (const code of creditCodes) {
    setupBuilder.addOperation(Operation.changeTrust({ asset: toStellarAsset(code) }));
  }
  const setupTx = setupBuilder
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: creatorPublicKey, weight: 1 },
      })
    )
    // Add platform as signer (weight 1)
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: PLATFORM_KEYPAIR.publicKey(), weight: 1 },
      })
    )
    // Set thresholds: medium ops (payments) require weight 2 (both signers)
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,     // disable the campaign keypair itself
        lowThreshold: 1,
        medThreshold: 2,
        highThreshold: 2,
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  setupTx.sign(campaignKeypair);
  await server.submitTransaction(setupTx);

  return {
    publicKey: campaignKeypair.publicKey(),
    secret: campaignKeypair.secret(),
  };
}

/**
 * Build an unsigned payment contribution transaction.
 */
async function buildUnsignedContributionPayment({
  senderPublicKey,
  destinationPublicKey,
  asset,
  amount,
  memo,
}) {
  const senderAccount = await server.loadAccount(senderPublicKey);
  const stellarAsset = toStellarAsset(asset);
  const { feeAmount, campaignAmount } = calcFee(amount);

  const builder = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: String(campaignAmount),
      })
    );

  if (feeAmount > 0) {
    builder.addOperation(
      Operation.payment({
        destination: PLATFORM_KEYPAIR.publicKey(),
        asset: stellarAsset,
        amount: String(feeAmount),
      })
    );
  }

  if (memo) builder.addMemo(Memo.text(memo));

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  return tx.toXDR();
}

/**
 * Build and sign a custodial payment contribution; returns XDR for audit + submission.
 */
async function prepareSignedContributionPayment({
  senderSecret,
  destinationPublicKey,
  asset,
  amount,
  memo,
}) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const { feeAmount } = calcFee(amount);
  const unsignedXdr = await buildUnsignedContributionPayment({
    senderPublicKey: senderKeypair.publicKey(),
    destinationPublicKey,
    asset,
    amount,
    memo,
  });
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(senderKeypair);
  const signedXdr = tx.toXDR();
  return { unsignedXdr, signedXdr, feeAmount };
}

/**
 * Submit a simple payment contribution (XLM or USDC direct).
 * For custodial users the backend signs on their behalf.
 */
async function submitPayment(params) {
  const { signedXdr } = await prepareSignedContributionPayment(params);
  return submitPreparedTransaction(signedXdr);
}

/**
 * Build an unsigned path payment contribution; `destAssetCode` is the asset the campaign receives.
 */
async function buildUnsignedContributionPathPayment({
  senderPublicKey,
  destinationPublicKey,
  sendAsset,
  sendMax,
  destAmount,
  destAssetCode,
  memo,
}) {
  const senderAccount = await server.loadAccount(senderPublicKey);
  const sourceStellarAsset = toStellarAsset(sendAsset);
  const destStellarAsset = toStellarAsset(destAssetCode);
  const { feeAmount, campaignAmount, bps } = calcFee(destAmount);

  const sendMaxFloat = parseFloat(sendMax);
  const campaignSendMax = feeAmount > 0
    ? ((sendMaxFloat * (1 - bps / 10000)).toFixed(7))
    : sendMax;
  const feeSendMax = feeAmount > 0
    ? ((sendMaxFloat * (bps / 10000)).toFixed(7))
    : '0';

  const builder = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: sourceStellarAsset,
        sendMax: String(campaignSendMax),
        destination: destinationPublicKey,
        destAsset: destStellarAsset,
        destAmount: String(campaignAmount),
        path: [],
      })
    );

  if (feeAmount > 0) {
    builder.addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: sourceStellarAsset,
        sendMax: String(feeSendMax),
        destination: PLATFORM_KEYPAIR.publicKey(),
        destAsset: destStellarAsset,
        destAmount: String(feeAmount),
        path: [],
      })
    );
  }

  if (memo) builder.addMemo(Memo.text(memo));

  const tx = builder.setTimeout(TX_TIMEOUT_CONTRIBUTION_S).build();
  return tx.toXDR();
}

/**
 * Build and sign a path payment contribution; `destAssetCode` is the asset the campaign receives.
 */
async function prepareSignedContributionPathPayment({
  senderSecret,
  destinationPublicKey,
  sendAsset,
  sendMax,
  destAmount,
  destAssetCode,
  memo,
}) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const { feeAmount } = calcFee(destAmount);
  const unsignedXdr = await buildUnsignedContributionPathPayment({
    senderPublicKey: senderKeypair.publicKey(),
    destinationPublicKey,
    sendAsset,
    sendMax,
    destAmount,
    destAssetCode,
    memo,
  });
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(senderKeypair);
  const signedXdr = tx.toXDR();
  return { unsignedXdr, signedXdr, feeAmount };
}

/**
 * Submit a path payment contribution.
 * The contributor sends `sendAsset`; the campaign receives exactly `destAmount` of `destAssetCode`.
 */
async function submitPathPayment(params) {
  const destAssetCode = params.destAssetCode || 'USDC';
  const { signedXdr } = await prepareSignedContributionPathPayment({
    ...params,
    destAssetCode,
  });
  return submitPreparedTransaction(signedXdr);
}

/**
 * Get a path payment quote for strict-receive contribution flow.
 * Returns candidate conversion paths from Stellar DEX.
 */
async function getPathPaymentQuote({ sendAsset, destAsset, destAmount }) {
  const sourceStellarAsset = toStellarAsset(sendAsset);
  const destinationStellarAsset = toStellarAsset(destAsset);

  const response = await server
    .strictReceivePaths(sourceStellarAsset, destinationStellarAsset, String(destAmount))
    .call();

  return (response.records || []).map((record) => ({
    source_asset: normalizeAsset({
      asset_type: record.source_asset_type,
      asset_code: record.source_asset_code,
    }),
    destination_asset: normalizeAsset({
      asset_type: record.destination_asset_type,
      asset_code: record.destination_asset_code,
    }),
    destination_amount: record.destination_amount,
    source_amount: record.source_amount,
    path: (record.path || []).map((pathAsset) => normalizeAsset(pathAsset)),
  }));
}

/**
 * Build a withdrawal transaction for a campaign wallet.
 * Returns the unsigned XDR — both the creator and platform must sign it.
 */
async function buildWithdrawalTransaction({
  campaignWalletPublicKey,
  destinationPublicKey,
  amount,
  asset,
}) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const stellarAsset = toStellarAsset(asset);

  const tx = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: String(amount),
      })
    )
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S) // platform approver may not be available immediately (see issue #128)
    .build();

  return tx.toXDR();
}

/**
 * Build a batch refund transaction for a campaign wallet returning funds to multiple contributors.
 * Returns the unsigned XDR.
 */
async function buildBatchRefundTransaction({
  campaignWalletPublicKey,
  refunds,
}) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const builder = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  for (const refund of refunds) {
    const stellarAsset = toStellarAsset(refund.asset);
    builder.addOperation(
      Operation.payment({
        destination: refund.destinationPublicKey,
        asset: stellarAsset,
        amount: String(refund.amount),
      })
    );
  }

  const tx = builder
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S) // 7 days
    .build();

  return tx.toXDR();
}

async function getAccountMultisigConfig(publicKey) {
  const account = await server.loadAccount(publicKey);
  return {
    thresholds: account.thresholds,
    signers: account.signers || [],
  };
}

function signTransactionXdr({ xdr, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function signatureCountFromXdr(xdr) {
  const tx = new Transaction(xdr, networkPassphrase);
  return tx.signatures.length;
}

/**
 * Returns true if the XDR transaction's maxTime has already passed.
 * Returns false if the XDR cannot be parsed or has no time bounds set.
 */
function isXdrExpired(xdr) {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    const { timeBounds } = tx;
    return !!(timeBounds && Math.floor(Date.now() / 1000) > Number(timeBounds.maxTime));
  } catch {
    return false;
  }
}

async function submitPreparedTransaction(xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function submitSignedWithdrawal({ xdr }) {
  return submitPreparedTransaction(xdr);
}

/**
 * Get the current balance of a campaign wallet.
 */
async function getCampaignBalance(publicKey) {
  const account = await server.loadAccount(publicKey);
  const balances = {};
  for (const b of account.balances) {
    const key = b.asset_type === 'native' ? 'XLM' : b.asset_code;
    balances[key] = b.balance;
  }
  return balances;
}

/**
 * Fund a new account on testnet using Friendbot.
 */
async function friendbotFund(publicKey) {
  if (!isTestnet) throw new Error('Friendbot only available on testnet');
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  return response.json();
}

/**
 * Recover campaign wallet from encrypted secret.
 */
function recoverWalletFromSecret(secret) {
  const keypair = Keypair.fromSecret(secret);
  return {
    publicKey: keypair.publicKey(),
    secret: keypair.secret(),
  };
}

/**
 * Get transaction history for a campaign wallet.
 */
async function getWalletTransactionHistory(publicKey, limit = 50) {
  const txs = await server.transactions()
    .forAccount(publicKey)
    .order('desc')
    .limit(limit)
    .call();
  
  return txs.records.map(tx => ({
    hash: tx.hash,
    created_at: tx.created_at,
    source_account: tx.source_account,
    fee_charged: tx.fee_charged,
    operation_count: tx.operation_count,
    memo: tx.memo,
  }));
}

/**
 * Get payment operations for a campaign wallet (audit trail).
 */
async function getWalletPayments(publicKey, limit = 100) {
  const payments = await server.payments()
    .forAccount(publicKey)
    .order('desc')
    .limit(limit)
    .call();
  
  return payments.records.map(p => ({
    id: p.id,
    type: p.type,
    created_at: p.created_at,
    transaction_hash: p.transaction_hash,
    from: p.from,
    to: p.to,
    amount: p.amount,
    asset_type: p.asset_type === 'native' ? 'XLM' : p.asset_code,
  }));
}

/**
 * Returns true if the error is a Stellar bad sequence number error (result code tx_bad_seq).
 * Used to detect sequence number conflicts so callers can retry with a fresh account load.
 */
function isBadSequenceError(err) {
  try {
    const extras = err?.response?.data?.extras;
    const resultCodes = extras?.result_codes;
    if (resultCodes?.transaction === 'tx_bad_seq') return true;
    // Also check envelope-level result code string
    const resultXdr = extras?.envelope_xdr || '';
    if (!resultXdr && typeof err?.message === 'string') {
      return err.message.includes('tx_bad_seq');
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  createCampaignWallet,
  toStellarAsset,
  getSupportedAssetCodes,
  listCreditAssetCodes,
  ensureCustodialAccountFundedAndTrusted,
  fundCustodialAccountFromPlatformIfNeeded,
  submitMissingTrustlinesForCustodialAccount,
  buildUnsignedContributionPayment,
  buildUnsignedContributionPathPayment,
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitPayment,
  submitPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  isXdrExpired,
  submitSignedWithdrawal,
  recoverWalletFromSecret,
  getWalletTransactionHistory,
  getWalletPayments,

  getCampaignBalance,
  friendbotFund,
  buildBatchRefundTransaction,
  isBadSequenceError,
  PLATFORM_PUBLIC_KEY: PLATFORM_KEYPAIR.publicKey(),
};
