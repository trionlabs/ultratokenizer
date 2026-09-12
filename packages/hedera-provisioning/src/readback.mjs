import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AccountId,
  FileContentsQuery,
  Hbar,
  PublicKey,
  Transaction,
  TransactionId,
  TransferTransaction,
} from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import sdkPackage from '@hiero-ledger/sdk/package.json' with { type: 'json' };
import { testnetClient } from './testnet-client.mjs';

const FORMAT = 'ultratokenizer.hfs-readback.v1';
const MAX_BYTES = 131072;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (value) => {
  if (!value)
    throw Error(
      'HFS readback requires its original bounded, signed payment and exact file contents.',
    );
};
function plain(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  check(
    keys.length === fields.length &&
      keys.every(
        (key) =>
          fields.includes(key) &&
          'value' in Object.getOwnPropertyDescriptor(value, key),
      ),
  );
  return Object.fromEntries(
    fields.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key).value,
    ]),
  );
}
function quantity(value, zero = false) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value));
  const parsed = BigInt(value);
  check(parsed <= (1n << 63n) - 1n && (zero || parsed > 0n));
  return parsed;
}
function entity(value) {
  check(typeof value === 'string' && /^0\.0\.[1-9][0-9]{0,18}$/.test(value));
  quantity(value.slice(4));
  return { shardNum: 0, realmNum: 0, fileNum: value.slice(4) };
}
function settings(value) {
  check(sdkPackage.version === '2.88.0');
  const result = plain(value, [
    'payer',
    'node',
    'transactionId',
    'publicKey',
    'fileId',
    'maxFeeTinybar',
    'queryPaymentTinybar',
    'expectedBytes',
    'contentsSha256',
  ]);
  entity(result.payer);
  entity(result.node);
  entity(result.fileId);
  check(result.payer !== result.node);
  check(
    typeof result.transactionId === 'string' &&
      /^0\.0\.[1-9][0-9]*@[1-9][0-9]*\.[0-9]{9}$/.test(result.transactionId),
  );
  const id = TransactionId.fromString(result.transactionId);
  check(
    id.toString() === result.transactionId &&
      id.accountId.toString() === result.payer,
  );
  quantity(result.maxFeeTinybar);
  quantity(result.queryPaymentTinybar);
  check(
    Number.isInteger(result.expectedBytes) &&
      result.expectedBytes > 0 &&
      result.expectedBytes <= MAX_BYTES,
  );
  check(
    typeof result.contentsSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(result.contentsSha256) &&
      !/^0+$/.test(result.contentsSha256),
  );
  result.publicKey = PublicKey.fromString(result.publicKey).toStringDer();
  return Object.freeze(result);
}
function paymentFor(config) {
  return new TransferTransaction()
    .addHbarTransfer(
      config.payer,
      Hbar.fromTinybars(`-${config.queryPaymentTinybar}`),
    )
    .addHbarTransfer(config.node, Hbar.fromTinybars(config.queryPaymentTinybar))
    .setTransactionId(TransactionId.fromString(config.transactionId))
    .setNodeAccountIds([AccountId.fromString(config.node)])
    .setTransactionValidDuration(120)
    .setMaxTransactionFee(Hbar.fromTinybars(config.maxFeeTinybar))
    .setMaxAttempts(1)
    .setRegenerateTransactionId(false)
    .freeze();
}
function transactionEntry(bytes) {
  const list = proto.TransactionList.decode(bytes).transactionList;
  check(list.length === 1 && list[0].signedTransactionBytes.length > 0);
  return list[0];
}
function paymentBody(bytes) {
  return proto.SignedTransaction.decode(
    transactionEntry(bytes).signedTransactionBytes,
  ).bodyBytes;
}
function queryBytes(config, paymentBytes) {
  return proto.Query.encode({
    fileGetContents: {
      header: {
        payment: transactionEntry(paymentBytes),
        responseType: proto.ResponseType.ANSWER_ONLY,
      },
      fileID: entity(config.fileId),
    },
  }).finish();
}
function exactContents(config, bytes) {
  check(
    bytes instanceof Uint8Array &&
      bytes.length === config.expectedBytes &&
      sha256(bytes) === config.contentsSha256,
  );
}

// SDK 2.88.0's ordinary Query path creates a payment in _beforeExecute and
// generates another in _makeRequestAsync. This private compatibility adapter
// sends the one independently built, signed and persisted official protobuf.
// It supplies no alternate endpoint, operator, payment ID, signer or retry path.
class RecordedPaymentQuery extends FileContentsQuery {
  constructor(config, bytes) {
    super({ fileId: config.fileId });
    this.config = config;
    this.recordedBytes = new Uint8Array(bytes);
    this.requestsMade = 0;
    this.setNodeAccountIds([AccountId.fromString(config.node)]);
    this.setPaymentTransactionId(
      TransactionId.fromString(config.transactionId),
    );
    this.setQueryPayment(Hbar.fromTinybars(config.queryPaymentTinybar));
    this.setMaxQueryPayment(Hbar.fromTinybars(config.queryPaymentTinybar));
    this.setMaxAttempts(1);
  }
  async _beforeExecute(client) {
    check(
      client.ledgerId?.toString() === 'testnet' &&
        client.isTransportSecurity() &&
        client.operatorAccountId === null,
    );
    check(
      Object.values(client.network).some(
        (id) => id.toString() === this.config.node,
      ),
    );
    check(
      this.paymentTransactionId.toString() === this.config.transactionId &&
        this.maxAttempts === 1,
    );
    this._nodeAccountIds.setLocked();
  }
  async _makeRequestAsync() {
    check(this.requestsMade === 0);
    this.requestsMade += 1;
    return proto.Query.decode(this.recordedBytes);
  }
  async _mapResponse(response) {
    const header = response.fileGetContents?.header;
    check(
      header &&
        header.nodeTransactionPrecheckCode === proto.ResponseCodeEnum.OK &&
        header.responseType === proto.ResponseType.ANSWER_ONLY,
    );
    const file = response.fileGetContents?.fileContents;
    check(
      file?.fileID &&
        String(file.fileID.shardNum ?? 0) === '0' &&
        String(file.fileID.realmNum ?? 0) === '0' &&
        String(file.fileID.fileNum) === this.config.fileId.slice(4),
    );
    exactContents(this.config, file.contents);
    return new Uint8Array(file.contents);
  }
}
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
async function append(handle, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
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
async function boundedText(handle, maximum) {
  const bytes = Buffer.alloc(maximum + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    check(bytesRead > 0 && bytesRead <= bytes.length - offset);
    offset += bytesRead;
  }
  check(offset > 0 && offset <= maximum);
  return bytes.subarray(0, offset).toString('utf8');
}
function result(config, signed, observed) {
  return Object.freeze({
    kind: 'file_readback',
    assurance: 'provider_observed',
    transactionId: config.transactionId,
    nativeHash: signed.nativeHash,
    fileId: config.fileId,
    contentsSha256: config.contentsSha256,
    observedAtUnix: observed.observedAtUnix,
    contents: new Uint8Array(Buffer.from(observed.contents, 'base64')),
  });
}

/** One paid file read with one explicit signed payment. No key or client is accepted. */
export async function readHfsContentsOnce({ journalPath, input, signer }) {
  const config = settings(input);
  check(typeof signer === 'function');
  return lock(journalPath, async () => {
    const journal = await open(journalPath, 'wx', 0o600);
    let client;
    try {
      await append(journal, {
        format: FORMAT,
        purpose: 'test',
        chainId: '296',
        config,
      });
      await syncDirectory(journalPath);
      const payment = paymentFor(config);
      const key = PublicKey.fromString(config.publicKey);
      const expectedBody = new Uint8Array(paymentBody(payment.toBytes()));
      await append(journal, {
        kind: 'signing_intent',
        transactionId: config.transactionId,
        body: Buffer.from(expectedBody).toString('base64'),
        bodySha256: sha256(expectedBody),
      });
      let signatures = 0;
      await payment.signWith(key, async (bytes) => {
        check(signatures === 0 && Buffer.from(bytes).equals(expectedBody));
        signatures += 1;
        const signature = new Uint8Array(await signer(new Uint8Array(bytes)));
        check(key.verify(bytes, signature));
        return signature;
      });
      check(signatures === 1 && key.verifyTransaction(payment));
      const signedBytes = payment.toBytes();
      const encodedQuery = queryBytes(config, signedBytes);
      check(signedBytes.length <= 8192 && encodedQuery.length <= 8192);
      const signed = {
        kind: 'signed_query',
        transactionId: config.transactionId,
        signedBytes: Buffer.from(signedBytes).toString('base64'),
        signedBytesSha256: sha256(signedBytes),
        queryBytes: Buffer.from(encodedQuery).toString('base64'),
        querySha256: sha256(encodedQuery),
        nativeHash: Buffer.from(await payment.getTransactionHash()).toString(
          'hex',
        ),
      };
      await append(journal, signed);
      const query = new RecordedPaymentQuery(config, encodedQuery);
      client = testnetClient();
      await append(journal, {
        kind: 'dispatch',
        transactionId: config.transactionId,
        querySha256: signed.querySha256,
      });
      try {
        const contents = await query.execute(client);
        exactContents(config, contents);
        const observed = {
          kind: 'readback',
          contents: Buffer.from(contents).toString('base64'),
          contentsSha256: config.contentsSha256,
          observedAtUnix: Math.floor(Date.now() / 1000),
        };
        await append(journal, observed);
        return result(config, signed, observed);
      } catch {
        return { kind: 'unresolved', transactionId: config.transactionId };
      }
    } finally {
      client?.close();
      await journal.close();
    }
  });
}

/** Recover only a completed local response. An ambiguous paid query is never issued again. */
export async function recoverHfsReadback(journalPath, expectedInput) {
  const expected = settings(expectedInput);
  return lock(journalPath, async () => {
    const journal = await open(
      journalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await journal.stat();
      check(
        stat.isFile() &&
          stat.size > 0 &&
          stat.size <= 262144 &&
          (stat.mode & 0o077) === 0,
      );
      const text = await boundedText(journal, 262144);
      check(text.endsWith('\n'));
      const events = text.slice(0, -1).split('\n').map(JSON.parse);
      check(events.length >= 1 && events.length <= 5);
      const head = plain(events[0], ['format', 'purpose', 'chainId', 'config']);
      check(
        head.format === FORMAT &&
          head.purpose === 'test' &&
          head.chainId === '296' &&
          JSON.stringify(settings(head.config)) === JSON.stringify(expected),
      );
      if (events.length >= 2) {
        const intent = plain(events[1], [
          'kind',
          'transactionId',
          'body',
          'bodySha256',
        ]);
        const body = paymentBody(paymentFor(expected).toBytes());
        check(
          intent.kind === 'signing_intent' &&
            intent.transactionId === expected.transactionId &&
            intent.body === Buffer.from(body).toString('base64') &&
            intent.bodySha256 === sha256(body),
        );
      }
      if (events.length < 3)
        return { kind: 'unresolved', transactionId: expected.transactionId };
      const signed = plain(events[2], [
        'kind',
        'transactionId',
        'signedBytes',
        'signedBytesSha256',
        'queryBytes',
        'querySha256',
        'nativeHash',
      ]);
      check(
        signed.kind === 'signed_query' &&
          signed.transactionId === expected.transactionId &&
          typeof signed.signedBytes === 'string',
      );
      const bytes = Buffer.from(signed.signedBytes, 'base64');
      check(
        bytes.length <= 8192 &&
          bytes.toString('base64') === signed.signedBytes &&
          sha256(bytes) === signed.signedBytesSha256,
      );
      check(
        Buffer.from(paymentBody(bytes)).equals(
          paymentBody(paymentFor(expected).toBytes()),
        ),
      );
      const payment = Transaction.fromBytes(bytes);
      check(
        PublicKey.fromString(expected.publicKey).verifyTransaction(payment) &&
          Buffer.from(await payment.getTransactionHash()).toString('hex') ===
            signed.nativeHash,
      );
      const encodedQuery = queryBytes(expected, bytes);
      check(
        signed.queryBytes === Buffer.from(encodedQuery).toString('base64') &&
          signed.querySha256 === sha256(encodedQuery),
      );
      if (events.length >= 4) {
        const dispatch = plain(events[3], [
          'kind',
          'transactionId',
          'querySha256',
        ]);
        check(
          dispatch.kind === 'dispatch' &&
            dispatch.transactionId === expected.transactionId &&
            dispatch.querySha256 === signed.querySha256,
        );
      }
      if (events.length < 5)
        return { kind: 'unresolved', transactionId: expected.transactionId };
      const observed = plain(events[4], [
        'kind',
        'contents',
        'contentsSha256',
        'observedAtUnix',
      ]);
      check(
        observed.kind === 'readback' &&
          observed.contentsSha256 === expected.contentsSha256 &&
          typeof observed.contents === 'string',
      );
      const contents = Buffer.from(observed.contents, 'base64');
      check(
        contents.toString('base64') === observed.contents &&
          Number.isSafeInteger(observed.observedAtUnix) &&
          observed.observedAtUnix > 0 &&
          observed.observedAtUnix <= Math.floor(Date.now() / 1000),
      );
      exactContents(expected, contents);
      return result(expected, signed, observed);
    } finally {
      await journal.close();
    }
  });
}
