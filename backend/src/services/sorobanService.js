const {
  Contract,
  Address,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  Operation,
  Asset,
} = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const { server, networkPassphrase, USDC } = require('../config/stellar');
const logger = require('../config/logger');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');

async function simulateAndPrepare(tx) {
  const simulation = await server.simulateTransaction(tx);
  if (
    simulation?.result?.meta &&
    xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64').v3().sorobanMeta().returnValue().type() === xdr.ScValType.scvError
  ) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.result)}`);
  }
  if (simulation?.error) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }
  return server.prepareTransaction(tx);
}

async function submitOperation(operation, signerSecret) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    const resultMetaXdr = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
    const returnValue = resultMetaXdr.v3().sorobanMeta().returnValue();
    return scValToNative(returnValue);
  }
  throw new Error(`Transaction failed: ${result.status}`);
}

async function invokeContract({ contractId, method, args, signerSecret }) {
  return submitOperation(new Contract(contractId).call(method, ...args), signerSecret);
}

/**
 * Encodes a milestone object for the Soroban contract.
 */
function encodeMilestone(m) {
  // Soroban #[contracttype] structs are ScMaps keyed by field-name symbols, sorted alphabetically.
  const titleHash = crypto.createHash('sha256').update(m.title).digest();
  const entry = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

  return xdr.ScVal.scvMap([
    entry('evidence_hash', xdr.ScVal.scvVoid()),
    entry('release_bps', nativeToScVal(m.release_percentage_units, { type: 'u32' })),
    entry('status', nativeToScVal(0, { type: 'u32' })), // Pending
    entry('title_hash', xdr.ScVal.scvBytes(titleHash)),
  ]);
}

function isProvisioningConfigured() {
  return Boolean(
    process.env.PLATFORM_SECRET_KEY &&
    process.env.ESCROW_WASM_HASH &&
    process.env.MILESTONES_WASM_HASH
  );
}

async function deployContract(wasmHash, signerSecret) {
  const signer = Keypair.fromSecret(signerSecret);
  return submitOperation(
    Operation.createCustomContract({
      address: new Address(signer.publicKey()),
      wasmHash: Buffer.from(wasmHash, 'hex'),
      salt: crypto.randomBytes(32),
    }),
    signerSecret
  );
}

/**
 * Deploys + initializes the escrow and milestones contracts for a campaign, then verifies
 * them by reading state back. Returns null when provisioning is not configured (pending state).
 * Throws if any deploy/initialize/verify step fails, so callers never persist unverified IDs.
 */
async function provisionCampaignContracts({
  campaignId,
  creatorPublicKey,
  targetAmount,
  assetType,
  deadline,
  milestones,
}) {
  if (!isProvisioningConfigured()) return null;

  const signerSecret = process.env.PLATFORM_SECRET_KEY;
  const platformPublicKey = Keypair.fromSecret(signerSecret).publicKey();

  const escrowId = await deployContract(process.env.ESCROW_WASM_HASH, signerSecret);
  const milestonesId = await deployContract(process.env.MILESTONES_WASM_HASH, signerSecret);

  const asset = assetType === 'XLM' ? Asset.native() : USDC;
  const campaignNumericId = BigInt('0x' + String(campaignId).replace(/-/g, '').slice(0, 16));
  const targetStroops = BigInt(Math.round(Number(targetAmount) * 1e7));
  const deadlineSecs = deadline ? BigInt(Math.floor(new Date(deadline).getTime() / 1000)) : 2n ** 64n - 1n;

  // The milestones contract must be the escrow admin so it can approve/execute withdrawals.
  await invokeContract({
    contractId: escrowId,
    method: 'initialize',
    args: [
      new Address(milestonesId).toScVal(),
      nativeToScVal(campaignNumericId, { type: 'u64' }),
      nativeToScVal(targetStroops, { type: 'i128' }),
      nativeToScVal(deadlineSecs, { type: 'u64' }),
      new Address(asset.contractId(networkPassphrase)).toScVal(),
    ],
    signerSecret,
  });

  await invokeContract({
    contractId: milestonesId,
    method: 'initialize',
    args: [
      new Address(creatorPublicKey).toScVal(),
      new Address(platformPublicKey).toScVal(),
      new Address(escrowId).toScVal(),
      xdr.ScVal.scvVec(milestones.map(encodeMilestone)),
    ],
    signerSecret,
  });

  // Verify state on-chain before reporting the contracts as usable.
  await invokeContract({ contractId: escrowId, method: 'get_total_raised', args: [], signerSecret });
  const stored = await invokeContract({
    contractId: milestonesId,
    method: 'get_all_milestones',
    args: [],
    signerSecret,
  });
  if (!Array.isArray(stored) || stored.length !== milestones.length) {
    throw new Error('Milestones contract verification failed: stored plan does not match');
  }

  return { escrowContractId: escrowId, milestonesContractId: milestonesId };
}

module.exports = {
  invokeContract,
  provisionCampaignContracts,
  isProvisioningConfigured,
  encodeMilestone,
  nativeToScVal,
};
