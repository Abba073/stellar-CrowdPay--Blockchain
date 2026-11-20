/**
 * campaignWallet.js
 *
 * Standalone scripts for campaign wallet management.
 * Run directly with Node.js for setup and debugging.
 *
 * Stellar Reserve Math:
 * Base reserve = 0.5 XLM per entry.
 * An active campaign wallet requires:
 *   - 2 base entries (account itself + master key): 1.0 XLM
 *   - 1 USDC trustline: 0.5 XLM
 *   - 2 additional signers (creator + platform): 1.0 XLM
 * Total minimum reserve = 2.5 XLM.
 * We fund with 3.0 XLM to comfortably cover reserve + transaction fees.
 *
 * Usage:
 *   node contracts/stellar/campaignWallet.js --setup-platform
 *   node contracts/stellar/campaignWallet.js --create <creatorPublicKey>
 *   node contracts/stellar/campaignWallet.js --inspect <walletPublicKey>
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../backend/.env') });

const {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require('@stellar/stellar-sdk');

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet ? Networks.TESTNET : Networks.PUBLIC;

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || (isTestnet ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org')
);
const USDC = new Asset('USDC', process.env.USDC_ISSUER);

function handleError(err) {
  console.error(err);
  process.exit(1);
}

// ─── Setup Platform Account ────────────────────────────────────────────────

async function setupPlatformAccount() {
  const keypair = Keypair.random();

  console.log('Generated platform keypair:');
  console.log('  Public key:', keypair.publicKey());
  console.log('  Secret key:', keypair.secret());

  if (isTestnet) {
    console.log('\nFunding via Friendbot…');
    const res = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Friendbot failed with status ${res.status}: ${errText}`);
    }
    await res.json();
  } else {
    console.log('\nMainnet detected: Friendbot skipped. Please fund account manually.');
  }

  const account = await server.loadAccount(keypair.publicKey());
  console.log('\nPlatform account funded.');
  console.log('Balances:', account.balances);
  console.log('\nAdd to backend/.env:');
  console.log(`PLATFORM_PUBLIC_KEY=${keypair.publicKey()}`);
  console.log(`PLATFORM_SECRET_KEY=${keypair.secret()}`);
}

// ─── Create Campaign Wallet ────────────────────────────────────────────────

async function createCampaignWallet(creatorPublicKey) {
  if (!process.env.PLATFORM_SECRET_KEY) throw new Error('PLATFORM_SECRET_KEY not set');

  const platformKeypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
  const campaignKeypair = Keypair.random();

  console.log('New campaign wallet:', campaignKeypair.publicKey());
  console.log('Funding from platform account…');

  const platformAccount = await server.loadAccount(platformKeypair.publicKey());

  // Step 1: Fund the campaign account with 3.0 XLM (covering 2.5 XLM reserve + fees)
  const fundTx = new TransactionBuilder(platformAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.createAccount({
        destination: campaignKeypair.publicKey(),
        startingBalance: '3.0',
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  fundTx.sign(platformKeypair);
  await server.submitTransaction(fundTx);
  console.log('Campaign account funded.');

  // Step 2: Configure multisig + trustline
  const campaignAccount = await server.loadAccount(campaignKeypair.publicKey());

  const setupTx = new TransactionBuilder(campaignAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: USDC, limit: '100000000' }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: creatorPublicKey, weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: platformKeypair.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  setupTx.sign(campaignKeypair);
  await server.submitTransaction(setupTx);

  console.log('\nCampaign wallet configured:');
  console.log('  Public key:', campaignKeypair.publicKey());
  console.log('  USDC trustline: established');
  console.log('  Signers: creator + platform (threshold 2)');
  console.log('  Master key: disabled');
}

// ─── Inspect Wallet ────────────────────────────────────────────────────────

async function inspectWallet(publicKey) {
  const account = await server.loadAccount(publicKey);
  console.log('Account:', publicKey);
  console.log('Balances:', account.balances);
  console.log('Signers:', account.signers);
  console.log('Thresholds:', account.thresholds);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const [,, flag, arg] = process.argv;

if (flag === '--setup-platform') setupPlatformAccount().catch(handleError);
else if (flag === '--create') createCampaignWallet(arg).catch(handleError);
else if (flag === '--inspect') inspectWallet(arg).catch(handleError);
else {
  console.log('Usage:');
  console.log('  node campaignWallet.js --setup-platform');
  console.log('  node campaignWallet.js --create <creatorPublicKey>');
  console.log('  node campaignWallet.js --inspect <walletPublicKey>');
}
