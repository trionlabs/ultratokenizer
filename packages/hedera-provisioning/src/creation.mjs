import {
  AccountId,
  EthereumTransaction,
  EthereumTransactionData,
  FileAppendTransaction,
  FileCreateTransaction,
  FileId,
  Hbar,
  PublicKey,
  Timestamp,
  TransactionId,
} from '@hiero-ledger/sdk';
import {
  bytesToHex,
  getAddress,
  getContractAddress,
  hexToBytes,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  zeroAddress,
} from 'viem';

const MAX_CREATION_BYTES = 64 * 1024;
const FILE_CHUNK_BYTES = 2048;
const INT64_MAX = (1n << 63n) - 1n;
const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export class HfsProvisioningError extends Error {
  constructor() {
    super(
      'The signed creation, independent policy or HFS transaction input is invalid.',
    );
    this.name = 'HfsProvisioningError';
  }
}

function requireValue(condition) {
  if (!condition) throw new HfsProvisioningError();
}
function record(value, fields) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
  );
  const keys = Reflect.ownKeys(value);
  requireValue(
    keys.length === fields.length &&
      keys.every(
        (key) =>
          fields.includes(key) &&
          'value' in Object.getOwnPropertyDescriptor(value, key),
      ),
  );
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(value, key).value,
      ]),
    ),
  );
}
function quantity(value, maximum = (1n << 256n) - 1n, zero = false) {
  requireValue(
    typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(value),
  );
  const parsed = BigInt(value);
  requireValue(parsed <= maximum && (zero || parsed > 0n));
  return parsed;
}
function entity(value, Type) {
  requireValue(
    typeof value === 'string' && /^0\.0\.[1-9][0-9]{0,18}$/.test(value),
  );
  quantity(value.slice(4), INT64_MAX);
  return Type.fromString(value);
}
function hash(value) {
  requireValue(
    typeof value === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(value) &&
      !/^0x0+$/.test(value),
  );
  return value.toLowerCase();
}
const NATIVE_FIELDS = ['payer', 'node', 'transactionId', 'maxFeeTinybar'];
function nativeTransaction(transaction, input) {
  const payer = entity(input.payer, AccountId);
  const node = entity(input.node, AccountId);
  requireValue(
    typeof input.transactionId === 'string' &&
      /^0\.0\.[1-9][0-9]{0,18}@[1-9][0-9]{0,18}\.[0-9]{9}$/.test(
        input.transactionId,
      ),
  );
  const id = TransactionId.fromString(input.transactionId);
  requireValue(
    id.accountId.toString() === payer.toString() &&
      id.toString() === input.transactionId,
  );
  quantity(input.maxFeeTinybar, INT64_MAX);
  return transaction
    .setNodeAccountIds([node])
    .setTransactionId(id)
    .setTransactionValidDuration(120)
    .setMaxTransactionFee(Hbar.fromTinybars(input.maxFeeTinybar))
    .setRegenerateTransactionId(false)
    .setMaxAttempts(1)
    .freeze();
}

/**
 * Authenticate an already signed direct creation, then construct offline native
 * transactions. No keys, Client, file upload, signing or submission occurs here.
 * HFS stores ASCII hex; consensus decodes it before restoring the signed RLP.
 */
export async function prepareHfsCreation(signedTransaction, inputPolicy) {
  try {
    const policy = record(inputPolicy, [
      'purpose',
      'chainId',
      'sender',
      'nonce',
      'creationHash',
      'maxGas',
      'maxFeePerGasWei',
      'maxTotalGasFeeWei',
    ]);
    requireValue(policy.purpose === 'test' && policy.chainId === '296');
    requireValue(typeof policy.sender === 'string');
    const sender = getAddress(policy.sender);
    requireValue(sender !== zeroAddress);
    const nonce = quantity(policy.nonce, BigInt(Number.MAX_SAFE_INTEGER), true);
    const creationHash = hash(policy.creationHash);
    const maxGas = quantity(policy.maxGas, 100_000_000n);
    const maxFeePerGas = quantity(policy.maxFeePerGasWei);
    const maxTotalGasFee = quantity(policy.maxTotalGasFeeWei);
    requireValue(
      typeof signedTransaction === 'string' &&
        /^0x02[0-9a-fA-F]+$/.test(signedTransaction) &&
        signedTransaction.length % 2 === 0 &&
        signedTransaction.length <= (MAX_CREATION_BYTES + 1024) * 2 + 2,
    );
    const signed = signedTransaction.toLowerCase();
    const tx = parseTransaction(signed);
    requireValue(
      tx.type === 'eip1559' &&
        tx.chainId === 296 &&
        !tx.to &&
        (tx.value ?? 0n) === 0n &&
        BigInt(tx.nonce ?? 0) === nonce &&
        tx.gas > 0n &&
        tx.gas <= maxGas &&
        tx.maxFeePerGas > 0n &&
        tx.maxFeePerGas <= maxFeePerGas &&
        tx.gas * tx.maxFeePerGas <= maxTotalGasFee &&
        (tx.maxPriorityFeePerGas ?? 0n) <= tx.maxFeePerGas &&
        (tx.accessList?.length ?? 0) === 0,
    );
    requireValue(
      typeof tx.data === 'string' &&
        tx.data.length > 2 &&
        tx.data.length <= MAX_CREATION_BYTES * 2 + 2 &&
        keccak256(tx.data) === creationHash,
    );
    requireValue(
      tx.r &&
        tx.s &&
        BigInt(tx.r) > 0n &&
        BigInt(tx.r) < CURVE_ORDER &&
        BigInt(tx.s) > 0n &&
        BigInt(tx.s) <= CURVE_ORDER / 2n &&
        (tx.yParity === 0 || tx.yParity === 1),
    );
    requireValue(
      serializeTransaction(tx, { r: tx.r, s: tx.s, yParity: tx.yParity }) ===
        signed,
    );
    requireValue(
      getAddress(
        await recoverTransactionAddress({ serializedTransaction: signed }),
      ) === sender,
    );

    // Capture immutable validated values, not the caller's mutable policy object.
    const fullData = tx.data.slice(2).toLowerCase();
    const fileChunks = Math.ceil(fullData.length / FILE_CHUNK_BYTES);
    const summary = Object.freeze({
      format: 'ultratokenizer.hfs-creation.v1',
      purpose: 'test',
      chainId: '296',
      sender,
      nonce: nonce.toString(),
      creationHash,
      ethereumTransactionHash: keccak256(signed),
      contractAddress: getContractAddress({ from: sender, nonce }),
      creationBytes: fullData.length / 2,
      fileBytes: fullData.length,
      fileChunks,
      maximumGasFeeWei: (tx.gas * tx.maxFeePerGas).toString(),
    });
    return Object.freeze({
      summary,
      createFile(input) {
        try {
          input = record(input, [...NATIVE_FIELDS, 'publicKey', 'expiresAt']);
          const key = PublicKey.fromString(input.publicKey);
          const expiry = quantity(
            input.expiresAt,
            BigInt(Number.MAX_SAFE_INTEGER),
          );
          const validStart = BigInt(
            TransactionId.fromString(
              input.transactionId,
            ).validStart.seconds.toString(),
          );
          requireValue(
            expiry >= validStart + 3600n && expiry <= validStart + 86400n,
          );
          const transaction = new FileCreateTransaction()
            .setKeys([key])
            .setContents(fullData.slice(0, FILE_CHUNK_BYTES))
            .setExpirationTime(new Timestamp(expiry.toString(), 0));
          return nativeTransaction(transaction, input);
        } catch {
          throw new HfsProvisioningError();
        }
      },
      appendFile(index, fileId, input) {
        try {
          input = record(input, NATIVE_FIELDS);
          requireValue(
            Number.isInteger(index) && index > 0 && index < fileChunks,
          );
          const transaction = new FileAppendTransaction()
            .setFileId(entity(fileId, FileId))
            .setContents(
              fullData.slice(
                index * FILE_CHUNK_BYTES,
                (index + 1) * FILE_CHUNK_BYTES,
              ),
            )
            .setChunkSize(FILE_CHUNK_BYTES)
            .setMaxChunks(1);
          return nativeTransaction(transaction, input);
        } catch {
          throw new HfsProvisioningError();
        }
      },
      createContract(fileId, observedFileContents, input) {
        try {
          input = record(input, [...NATIVE_FIELDS, 'maxGasAllowanceTinybar']);
          requireValue(
            observedFileContents instanceof Uint8Array &&
              observedFileContents.length === fullData.length &&
              Buffer.from(observedFileContents).equals(
                Buffer.from(fullData, 'ascii'),
              ),
          );
          quantity(input.maxGasAllowanceTinybar, INT64_MAX, true);
          const restored = EthereumTransactionData.fromBytes(
            hexToBytes(signed),
          );
          restored.callData = new Uint8Array();
          const hollow = restored.toBytes();
          restored.callData = Buffer.from(fullData, 'hex');
          requireValue(bytesToHex(restored.toBytes()) === signed);
          const transaction = new EthereumTransaction()
            .setEthereumData(hollow)
            .setCallDataFileId(entity(fileId, FileId))
            .setMaxGasAllowanceHbar(
              Hbar.fromTinybars(input.maxGasAllowanceTinybar),
            );
          return nativeTransaction(transaction, input);
        } catch {
          throw new HfsProvisioningError();
        }
      },
    });
  } catch {
    throw new HfsProvisioningError();
  }
}
