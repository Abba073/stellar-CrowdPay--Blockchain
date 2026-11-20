const {
  Keypair,
  TransactionBuilder,
  WebAuth,
} = require('@stellar/stellar-sdk');
const { Networks } = require('@stellar/stellar-sdk');
const { configuredAssets } = require('../config/stellar');

function moneyGramEnvironmentConfig() {
  const env = process.env.ANCHOR_MONEYGRAM_ENV || (process.env.STELLAR_NETWORK === 'mainnet' ? 'production' : 'sandbox');
  if (env === 'sandbox') {
    return {
      id: 'moneygram',
      name: 'MoneyGram Ramps',
      environment: 'sandbox',
      homeDomain: 'extstellar.moneygram.com',
      webAuthEndpoint: 'https://extstellar.moneygram.com/stellaradapterservice/auth',
      sep24Endpoint: 'https://extstellar.moneygram.com/stellaradapterservice/sep24',
      signingKey: 'GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS',
      networkPassphrase: Networks.TESTNET,
      assetCode: 'USDC',
      assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      market: 'global-usd',
      rails: ['cash'],
      testnetAvailable: true,
      productionAvailable: true,
    };
  }
  if (env === 'preview') {
    return {
      id: 'moneygram',
      name: 'MoneyGram Ramps',
      environment: 'preview',
      homeDomain: 'previewstellar.moneygram.com',
      webAuthEndpoint: 'https://previewstellar.moneygram.com/stellaradapterservicepreview/auth',
      sep24Endpoint: 'https://previewstellar.moneygram.com/stellaradapterservicepreview/sep24',
      signingKey: 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
      networkPassphrase: Networks.PUBLIC,
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      market: 'global-usd',
      rails: ['cash'],
      testnetAvailable: true,
      productionAvailable: true,
    };
  }
  return {
    id: 'moneygram',
    name: 'MoneyGram Ramps',
    environment: 'production',
    homeDomain: 'stellar.moneygram.com',
    webAuthEndpoint: 'https://stellar.moneygram.com/stellaradapterservice/auth',
    sep24Endpoint: 'https://stellar.moneygram.com/stellaradapterservice/sep24',
    signingKey: 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
    networkPassphrase: Networks.PUBLIC,
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    market: 'global-usd',
    rails: ['cash'],
    testnetAvailable: true,
    productionAvailable: true,
  };
}

function customAnchorConfig() {
  if (
    !process.env.ANCHOR_CUSTOM_ID ||
    !process.env.ANCHOR_CUSTOM_NAME ||
    !process.env.ANCHOR_CUSTOM_HOME_DOMAIN ||
    !process.env.ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT ||
    !process.env.ANCHOR_CUSTOM_SEP24_ENDPOINT ||
    !process.env.ANCHOR_CUSTOM_SIGNING_KEY ||
    !process.env.ANCHOR_CUSTOM_ASSET_CODE ||
    !process.env.ANCHOR_CUSTOM_ASSET_ISSUER
  ) {
    return null;
  }

  return {
    id: process.env.ANCHOR_CUSTOM_ID,
    name: process.env.ANCHOR_CUSTOM_NAME,
    environment: process.env.ANCHOR_CUSTOM_ENV || 'production',
    homeDomain: process.env.ANCHOR_CUSTOM_HOME_DOMAIN,
    webAuthEndpoint: process.env.ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT,
    sep24Endpoint: process.env.ANCHOR_CUSTOM_SEP24_ENDPOINT,
    signingKey: process.env.ANCHOR_CUSTOM_SIGNING_KEY,
    networkPassphrase:
      process.env.ANCHOR_CUSTOM_NETWORK === 'testnet' ? Networks.TESTNET : Networks.PUBLIC,
    assetCode: process.env.ANCHOR_CUSTOM_ASSET_CODE,
    assetIssuer: process.env.ANCHOR_CUSTOM_ASSET_ISSUER,
    market: process.env.ANCHOR_CUSTOM_MARKET || 'custom',
    rails: process.env.ANCHOR_CUSTOM_RAILS
      ? process.env.ANCHOR_CUSTOM_RAILS.split(',').map((value) => value.trim()).filter(Boolean)
      : ['bank'],
    testnetAvailable: process.env.ANCHOR_CUSTOM_TESTNET === 'true',
    productionAvailable: true,
  };
}

function getAvailableAnchors() {
  const anchors = [];
  if (process.env.ANCHOR_MONEYGRAM_ENABLED !== 'false') {
    anchors.push(moneyGramEnvironmentConfig());
  }
  const custom = customAnchorConfig();
  if (custom) anchors.push(custom);
  return anchors;
}

function getAnchorById(anchorId) {
  return getAvailableAnchors().find((anchor) => anchor.id === anchorId) || null;
}

function walletDomainConfig() {
  return {
    homeDomain: process.env.ANCHOR_WALLET_HOME_DOMAIN || '',
    signingSecret: process.env.ANCHOR_WALLET_SIGNING_SECRET || '',
  };
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload?.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

function isAnchorConfigured(anchor) {
  const walletDomain = walletDomainConfig();
  return Boolean(
    anchor &&
    configuredAssets[anchor.assetCode]?.issuer &&
    walletDomain.homeDomain &&
    walletDomain.signingSecret
  );
}

function publicAnchorInfo(anchor) {
  return {
    id: anchor.id,
    name: anchor.name,
    environment: anchor.environment,
    market: anchor.market,
    rails: anchor.rails,
    testnet_available: anchor.testnetAvailable,
    production_available: anchor.productionAvailable,
    interactive_protocol: 'sep24',
    auth_protocol: 'sep10',
    asset: {
      code: anchor.assetCode,
      issuer: anchor.assetIssuer,
    },
    available: isAnchorConfigured(anchor),
  };
}

const SEP_TIMEOUT_MS = 9000;

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(SEP_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      const error = new Error('Anchor request timed out');
      error.statusCode = 502;
      error.payload = { code: 'ANCHOR_TIMEOUT', retryable: true };
      throw error;
    }
    throw err;
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const error = new Error(data.error || data.detail || `Anchor request failed (${response.status})`);
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function authenticateWithAnchor({
  anchor,
  userPublicKey,
  userSecret,
}) {
  const walletDomain = walletDomainConfig();
  if (!walletDomain.homeDomain || !walletDomain.signingSecret) {
    const error = new Error('Anchor wallet domain signing is not configured on the backend');
    error.statusCode = 503;
    throw error;
  }

  const challenge = await fetchJson(
    `${anchor.webAuthEndpoint}?${new URLSearchParams({
      account: userPublicKey,
      client_domain: walletDomain.homeDomain,
    }).toString()}`
  );
  if (!challenge.transaction) {
    const error = new Error('Anchor challenge response did not include a transaction');
    error.statusCode = 502;
    throw error;
  }

  const parsedChallenge = WebAuth.readChallengeTx(
    challenge.transaction,
    anchor.signingKey,
    anchor.networkPassphrase,
    anchor.homeDomain,
    new URL(anchor.webAuthEndpoint).host
  );
  if (!WebAuth.verifyTxSignedBy(parsedChallenge.tx, anchor.signingKey)) {
    const error = new Error('Anchor challenge was not signed by the expected anchor key');
    error.statusCode = 502;
    throw error;
  }

  const tx = TransactionBuilder.fromXDR(challenge.transaction, anchor.networkPassphrase);
  tx.sign(Keypair.fromSecret(userSecret));
  tx.sign(Keypair.fromSecret(walletDomain.signingSecret));

  const tokenResponse = await fetchJson(anchor.webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (!tokenResponse.token) {
    const error = new Error('Anchor token response did not include a bearer token');
    error.statusCode = 502;
    throw error;
  }

  return {
    token: tokenResponse.token,
    expiresAt: decodeJwtExp(tokenResponse.token),
  };
}

async function startInteractiveDeposit({
  anchor,
  authToken,
  userPublicKey,
  amount,
}) {
  const body = new URLSearchParams({
    asset_code: anchor.assetCode,
    account: userPublicKey,
    amount: String(amount),
    lang: 'en',
  });
  const response = await fetchJson(`${anchor.sep24Endpoint}/transactions/deposit/interactive`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.id || !response.url) {
    const error = new Error('Anchor did not return an interactive URL for this deposit');
    error.statusCode = 502;
    throw error;
  }
  return response;
}

async function getAnchorTransaction({ anchor, authToken, transactionId }) {
  return fetchJson(
    `${anchor.sep24Endpoint}/transaction?${new URLSearchParams({ id: transactionId }).toString()}`,
    {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    }
  );
}

function isAnchorTerminalStatus(status) {
  return ['completed', 'error', 'expired', 'no_market', 'too_small', 'too_large'].includes(status);
}

function isAnchorFailureStatus(status) {
  return ['error', 'expired', 'no_market', 'too_small', 'too_large'].includes(status);
}

module.exports = {
  getAvailableAnchors,
  getAnchorById,
  publicAnchorInfo,
  isAnchorConfigured,
  authenticateWithAnchor,
  startInteractiveDeposit,
  getAnchorTransaction,
  isAnchorTerminalStatus,
  isAnchorFailureStatus,
};
