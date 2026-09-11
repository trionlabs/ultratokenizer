import { constants } from 'node:fs';
import { open, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  Client,
  EthereumTransaction,
  FileAppendTransaction,
  FileCreateTransaction,
  PublicKey,
  Transaction,
} from '@hiero-ledger/sdk';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => {
  throw new Error(
    'HFS submission is invalid, already attempted or requires explicit recovery.',
  );
};
const check = (condition) => {
  if (!condition) fail();
};
const hexBytes = (bytes) => Buffer.from(bytes).toString('hex');
const FORMAT = 'ultratokenizer.hfs-submission.v1';

async function syncDirectory(path) {
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function lock(path, action) {
  const lockPath = `${path}.lock`;
  const handle = await open(lockPath, 'wx', 0o600);
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}
async function append(handle, event) {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    check(
      Number.isInteger(bytesWritten) &&
        bytesWritten > 0 &&
        bytesWritten <= bytes.length - offset,
    );
    offset += bytesWritten;
  }
  await handle.sync();
}
function testnetClient() {
  return Client.forTestnet({ scheduleNetworkUpdate: false })
    .setTransportSecurity(true)
    .setMaxAttempts(1)
    .setRequestTimeout(15_000);
}
function transactionKind(transaction) {
  if (transaction instanceof FileCreateTransaction) return 'file_create';
  if (
    transaction instanceof FileAppendTransaction &&
    transaction.getRequiredChunks() === 1
  )
    return 'file_append';
  if (transaction instanceof EthereumTransaction) return 'ethereum_create';
  fail();
}
function nativeMetadata(transaction) {
  check(transaction.isFrozen());
  const kind = transactionKind(transaction);
  const id = transaction.transactionId;
  const nodeIds = transaction.nodeAccountIds;
  check(
    id && nodeIds?.length === 1 && transaction.transactionValidDuration === 120,
  );
  check(/^0\.0\.[1-9][0-9]*@[1-9][0-9]*\.[0-9]{9}$/.test(id.toString()));
  const fee = transaction.maxTransactionFee?.toTinybars().toString();
  check(typeof fee === 'string' && /^[1-9][0-9]*$/.test(fee));
  // Submission accepts only already frozen output; builders validate signed EVM
  // identity/data and operation policy. No caller-controlled Client is accepted.
  return {
    kind,
    transactionId: id.toString(),
    node: nodeIds[0].toString(),
    maxFeeTinybar: fee,
  };
}
async function recordedObservation(metadata) {
  const id = metadata.transactionId
    .replace('@', '-')
    .replace(/\.([0-9]{9})$/, '-$1');
  const response = await fetch(
    `https://testnet.mirrornode.hedera.com/api/v1/transactions/${id}`,
    {
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    },
  );
  check(response.ok && response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      check(size <= 262144);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  check(
    Array.isArray(body.transactions) &&
      body.transactions.length > 0 &&
      body.transactions.length <= 100,
  );
  const encodedHash = Buffer.from(metadata.nativeHash, 'hex').toString(
    'base64',
  );
  const candidates = body.transactions.filter(
    (tx) =>
      tx &&
      tx.transaction_id === id &&
      tx.transaction_hash === encodedHash &&
      tx.nonce === 0 &&
      tx.scheduled === false,
  );
  check(candidates.length === 1);
  const tx = candidates[0];
  const expectedName = {
    file_create: 'FILECREATE',
    file_append: 'FILEAPPEND',
    ethereum_create: 'ETHEREUMTRANSACTION',
  };
  check(tx.name === expectedName[metadata.kind] && tx.node === metadata.node);
  check(
    typeof tx.consensus_timestamp === 'string' &&
      /^[1-9][0-9]*\.[0-9]{9}$/.test(tx.consensus_timestamp),
  );
  check(
    typeof tx.result === 'string' &&
      /^[A-Z][A-Z0-9_]{0,100}$/.test(tx.result) &&
      !['UNKNOWN', 'RECEIPT_NOT_FOUND', 'BUSY'].includes(tx.result),
  );
  if (tx.result === 'SUCCESS')
    check(
      typeof tx.entity_id === 'string' &&
        /^0\.0\.[1-9][0-9]*$/.test(tx.entity_id),
    );
  return {
    kind: 'mirror_observation',
    assurance: 'provider_observed',
    transactionId: metadata.transactionId,
    nativeHash: metadata.nativeHash,
    status: tx.result,
    consensusTimestamp: tx.consensus_timestamp,
    fileId:
      tx.result === 'SUCCESS' && metadata.kind !== 'ethereum_create'
        ? tx.entity_id
        : null,
    contractId:
      tx.result === 'SUCCESS' && metadata.kind === 'ethereum_create'
        ? tx.entity_id
        : null,
  };
}

/**
 * Submit exactly one prepared, payer-signed native operation to the built-in
 * testnet network. The unique journal is the operation's durable identity.
 * Reusing a journal never resends, including after a precheck/timeout/crash.
 * Call recoverHfsSubmission to query the recorded ID without signing/submitting.
 * This boundary is not a multi-operation deployment scheduler or fee budget.
 */
export async function submitHfsOnce({
  journalPath,
  transaction,
  publicKey,
  signer,
}) {
  return lock(journalPath, async () => {
    await lstat(journalPath).then(
      () => fail(),
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    check(
      transaction.maxAttempts === 1 &&
        transaction.regenerateTransactionId === false,
    );
    transaction = Transaction.fromBytes(transaction.toBytes());
    transaction.setMaxAttempts(1);
    // Reading the explicit ID locks the SDK transaction-ID list. This privately
    // owned instance has no operator and cannot sign a regenerated transaction.
    const metadata = nativeMetadata(transaction);
    const key = PublicKey.fromString(publicKey);
    await transaction.signWith(key, (bytes) => signer(new Uint8Array(bytes)));
    check(key.verifyTransaction(transaction));
    const bytes = transaction.toBytes();
    check(bytes.length > 0 && bytes.length <= 8192);
    const nativeHash = hexBytes(await transaction.getTransactionHash());
    const record = {
      format: FORMAT,
      purpose: 'test',
      chainId: '296',
      ...metadata,
      publicKey: key.toStringDer(),
      signedBytes: Buffer.from(bytes).toString('base64'),
      signedBytesSha256: sha256(bytes),
      nativeHash,
    };
    // create_new, then durable bytes and dispatch marker, then exactly one call.
    // A crash at either journal boundary is conservatively uncertain.
    const journal = await open(journalPath, 'wx', 0o600);
    let client;
    try {
      await append(journal, record);
      await syncDirectory(journalPath);
      client = testnetClient();
      check(
        Object.values(client.network).some(
          (node) => node.toString() === metadata.node,
        ),
      );
      await append(journal, {
        kind: 'dispatch',
        transactionId: metadata.transactionId,
      });
      try {
        const response = await transaction.execute(client);
        check(
          response.transactionId.toString() === metadata.transactionId &&
            hexBytes(response.transactionHash) === nativeHash,
        );
        const receipt = await recordedObservation(record);
        await append(journal, receipt);
        return receipt;
      } catch {
        return { kind: 'unresolved', transactionId: metadata.transactionId };
      }
    } finally {
      client?.close();
      await journal.close();
    }
  });
}

/** Read-only recovery rechecks the official mirror; local outcomes are never authority. */
export async function recoverHfsSubmission(journalPath) {
  return lock(journalPath, async () => {
    const journal = await open(
      journalPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const stat = await journal.stat();
      check(
        stat.isFile() &&
          stat.size > 0 &&
          stat.size <= 32768 &&
          (stat.mode & 0o077) === 0,
      );
      const text = await journal.readFile('utf8');
      check(text.endsWith('\n'));
      const events = text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line));
      check(events.length >= 1 && events.length <= 3);
      const record = events[0];
      check(
        record.format === FORMAT &&
          record.purpose === 'test' &&
          record.chainId === '296',
      );
      check(
        typeof record.signedBytes === 'string' &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(record.signedBytes),
      );
      const bytes = Buffer.from(record.signedBytes, 'base64');
      check(
        bytes.toString('base64') === record.signedBytes &&
          sha256(bytes) === record.signedBytesSha256,
      );
      const transaction = Transaction.fromBytes(bytes);
      const metadata = nativeMetadata(transaction);
      check(
        Object.entries(metadata).every(([key, value]) => record[key] === value),
      );
      check(
        PublicKey.fromString(record.publicKey).verifyTransaction(transaction),
      );
      check(
        hexBytes(await transaction.getTransactionHash()) === record.nativeHash,
      );
      if (events.length > 1)
        check(
          events[1].kind === 'dispatch' &&
            events[1].transactionId === metadata.transactionId,
        );
      if (events.length === 3) {
        check(
          events[2].kind === 'mirror_observation' &&
            events[2].transactionId === metadata.transactionId &&
            events[2].nativeHash === record.nativeHash,
        );
      }
      try {
        const receipt = await recordedObservation(record);
        // A prepared-only crash is queried too; recording the conservative
        // dispatch marker preserves a single parseable recovery shape.
        if (events.length === 1)
          await append(journal, {
            kind: 'dispatch',
            transactionId: metadata.transactionId,
          });
        if (events.length < 3) await append(journal, receipt);
        return receipt;
      } catch {
        return { kind: 'unresolved', transactionId: metadata.transactionId };
      }
    } finally {
      await journal.close();
    }
  });
}
