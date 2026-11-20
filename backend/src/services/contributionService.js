const { insertContributionSubmitted } = require('./stellarTransactionService');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const {
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitWithFeeBumpFallback,
  getPathPaymentQuote,
  ensureCustodialAccountFundedAndTrusted,
} = require('./stellarService');
const { SLIPPAGE_BPS } = require('../config/constants');

function buildContributionMemo(campaignId) {
  return `cp-${String(campaignId).replace(/-/g, '').slice(0, 25)}`.slice(0, 28);
}

async function buildContributionIntent({
  campaign,
  amount,
  sendAsset,
  contributorPublicKey,
  displayName,
}) {
  if (sendAsset === campaign.asset_type) {
    return {
      kind: 'payment',
      conversionQuote: null,
      flowMetadata: {
        flow: 'payment',
        send_asset: sendAsset,
        amount: String(amount),
        contributor_public_key: contributorPublicKey,
        display_name: displayName || null,
      },
    };
  }

  const paths = await getPathPaymentQuote({
    sendAsset,
    destAsset: campaign.asset_type,
    destAmount: amount,
  });
  if (!paths.length) {
    const error = new Error(`No conversion path found for ${sendAsset} -> ${campaign.asset_type}`);
    error.statusCode = 422;
    throw error;
  }

  const bestPath = paths[0];
  const sendMax = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  return {
    kind: 'path_payment_strict_receive',
    sendMax,
    conversionQuote: {
      send_asset: sendAsset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    },
    flowMetadata: {
      flow: 'path_payment_strict_receive',
      send_asset: sendAsset,
      dest_asset: campaign.asset_type,
      dest_amount: String(amount),
      max_send_amount: sendMax,
      contributor_public_key: contributorPublicKey,
      display_name: displayName || null,
    },
  };
}

async function submitCustodialContribution({
  campaign,
  campaignId,
  userId,
  walletPublicKey,
  walletSecretEncrypted,
  amount,
  sendAsset,
  intentOverride,
  anchorMetadata,
  displayName,
}) {
  const intent =
    intentOverride ||
    (await buildContributionIntent({
      campaign,
      amount,
      sendAsset,
      contributorPublicKey: walletPublicKey,
      displayName,
    }));

  const preparedTransaction = await withDecryptedWalletSecret(
    walletSecretEncrypted,
    {
      userId,
      walletPublicKey,
    },
    async (senderSecret) => {
      await ensureCustodialAccountFundedAndTrusted({
        publicKey: walletPublicKey,
        secret: senderSecret,
      });

      if (intent.kind === 'payment') {
        return prepareSignedContributionPayment({
          senderSecret,
          destinationPublicKey: campaign.wallet_public_key,
          asset: sendAsset,
          amount,
          memo: buildContributionMemo(campaignId),
        });
      }

      return prepareSignedContributionPathPayment({
        senderSecret,
        destinationPublicKey: campaign.wallet_public_key,
        sendAsset,
        sendMax: intent.sendMax,
        destAmount: amount,
        destAssetCode: campaign.asset_type,
        memo: buildContributionMemo(campaignId),
      });
    }
  );

  const unsignedXdr = preparedTransaction.unsignedXdr;
  const signedXdr = preparedTransaction.signedXdr;
  let txHash;
  try {
    txHash = await submitWithFeeBumpFallback(signedXdr);
  } catch (err) {
    err.statusCode = err.statusCode || 502;
    throw err;
  }
  const metadata = {
    ...intent.flowMetadata,
    ...(anchorMetadata
      ? {
          anchor: {
            anchor_id: anchorMetadata.anchor_id,
            anchor_transaction_id: anchorMetadata.anchor_transaction_id,
            anchor_asset: anchorMetadata.anchor_asset,
            anchor_amount: anchorMetadata.anchor_amount,
            anchor_deposit_id: anchorMetadata.anchor_deposit_id,
          },
        }
      : {}),
  };

  const stellarTransactionId = await insertContributionSubmitted(null, {
    txHash,
    campaignId,
    userId,
    unsignedXdr,
    signedXdr,
    metadata,
  });

  return {
    txHash,
    stellarTransactionId,
    unsignedXdr,
    signedXdr,
    conversionQuote: intent.conversionQuote,
    flowMetadata: metadata,
  };
}

module.exports = {
  buildContributionIntent,
  buildContributionMemo,
  submitCustodialContribution,
};
