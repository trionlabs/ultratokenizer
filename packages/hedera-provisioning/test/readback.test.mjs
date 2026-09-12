import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  FileContentsQuery,
  PrivateKey,
  Transaction,
  TransactionId,
  TransferTransaction,
} from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import { readHfsContentsOnce, recoverHfsReadback } from '../src/readback.mjs';

const key = PrivateKey.fromStringECDSA('02'.repeat(32));
const contents = Buffer.from('60006000'.repeat(256), 'ascii');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ut-readback-'));
  return {
    journalPath: join(directory, 'readback.jsonl'),
    input: {
      payer: '0.0.1001',
      node: '0.0.3',
      transactionId: '0.0.1001@1789090000.000000001',
      publicKey: key.publicKey.toStringDer(),
      fileId: '0.0.2001',
      maxFeeTinybar: '100000000',
      queryPaymentTinybar: '50000',
      expectedBytes: contents.length,
      contentsSha256: sha256(contents),
    },
    signer: async (bytes) => key.sign(bytes),
  };
}
async function answer(query, client, args, mutation = {}) {
  await query._beforeExecute(client);
  const request = await query._makeRequestAsync();
  assert.equal(query.paymentTransactionId.toString(), args.input.transactionId);
  assert.equal(client.ledgerId.toString(), 'testnet');
  assert.equal(client.isTransportSecurity(), true);
  assert.equal(client.operatorAccountId, null);
  assert.equal(query.maxAttempts, 1);
  const events = (await readFile(args.journalPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(events[3].kind, 'dispatch');
  assert.equal(
    events[2].queryBytes,
    Buffer.from(proto.Query.encode(request).finish()).toString('base64'),
  );
  const transaction = Transaction.fromBytes(
    proto.Transaction.encode(request.fileGetContents.header.payment).finish(),
  );
  assert.ok(transaction instanceof TransferTransaction);
  assert.equal(transaction.transactionId.toString(), args.input.transactionId);
  assert.equal(
    transaction.maxTransactionFee.toTinybars().toString(),
    args.input.maxFeeTinybar,
  );
  assert.equal(key.publicKey.verifyTransaction(transaction), true);
  assert.equal(
    transaction.hbarTransfers.get('0.0.1001').toTinybars().toString(),
    '-50000',
  );
  assert.equal(
    transaction.hbarTransfers.get('0.0.3').toTinybars().toString(),
    '50000',
  );
  await assert.rejects(query._makeRequestAsync());
  return query._mapResponse({
    fileGetContents: {
      header: {
        nodeTransactionPrecheckCode: proto.ResponseCodeEnum.OK,
        responseType: proto.ResponseType.ANSWER_ONLY,
      },
      fileContents: { fileID: { fileNum: '2001' }, contents, ...mutation },
    },
  });
}

await test('HTTPS SDK file read dispatches the exact durable query and accepts its framed response', async (t) => {
  const args = await fixture();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://testnet-node00-00-grpc.hedera.com');
    if (endpoint.pathname === '/')
      return new Response(null, { headers: { 'grpc-status': '12' } });
    assert.equal(endpoint.pathname, '/proto.FileService/getFileContent');
    requests++;
    const records = (await readFile(args.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const request = Buffer.from(options.body).subarray(5);
    assert.equal(request.toString('base64'), records[2].queryBytes);
    const payload = proto.Response.encode({
      fileGetContents: {
        header: {},
        fileContents: { fileID: { fileNum: '2001' }, contents },
      },
    }).finish();
    const frame = Buffer.alloc(payload.length + 5);
    frame.writeUInt32BE(payload.length, 1);
    frame.set(payload, 5);
    return new Response(frame, {
      headers: { 'content-type': 'application/grpc-web+proto' },
    });
  });
  const result = await readHfsContentsOnce(args);
  assert.equal(result.kind, 'file_readback');
  assert.equal(requests, 1);
  assert.deepEqual(Buffer.from(result.contents), contents);
});

await test('recorded query payment hooks preserve the original native ID and signature', async (t) => {
  const args = await fixture();
  let signatures = 0;
  args.signer = async (bytes) => {
    signatures += 1;
    const signature = key.sign(bytes);
    bytes.fill(0);
    return signature;
  };
  const generated = t.mock.method(TransactionId, 'generate', () => {
    throw Error('Readback must retain its explicit native ID');
  });
  const execute = t.mock.method(
    FileContentsQuery.prototype,
    'execute',
    async function (client) {
      return answer(this, client, args);
    },
  );
  const observed = await readHfsContentsOnce(args);
  assert.equal(observed.kind, 'file_readback');
  assert.equal(observed.assurance, 'provider_observed');
  assert.deepEqual(Buffer.from(observed.contents), contents);
  assert.equal(signatures, 1);
  assert.equal(generated.mock.callCount(), 0);
  assert.equal((await stat(args.journalPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await recoverHfsReadback(args.journalPath, args.input),
    observed,
  );
  await assert.rejects(readHfsContentsOnce(args));
  assert.equal(signatures, 1);
  assert.equal(execute.mock.callCount(), 1);
});

await test('inherited SDK execute dispatches the durable query exactly once without regenerating its payment', async (t) => {
  const args = await fixture();
  let signatures = 0;
  args.signer = async (bytes) => {
    signatures += 1;
    return key.sign(bytes);
  };
  const generated = t.mock.method(TransactionId, 'generate', () => {
    throw Error('The SDK must not allocate another query payment');
  });
  // Only the RPC dispatch is intercepted. SDK setup, node selection, request
  // creation, status handling and response mapping run through real execute.
  const dispatch = t.mock.method(
    FileContentsQuery.prototype,
    '_execute',
    async function (_channel, request) {
      assert.equal(Object.hasOwn(this, 'execute'), false);
      assert.equal(
        Object.hasOwn(Object.getPrototypeOf(this), 'execute'),
        false,
      );
      assert.equal(
        this.paymentTransactionId.toString(),
        args.input.transactionId,
      );
      assert.equal(this.maxAttempts, 1);
      assert.equal(this.requestsMade, 1);
      const events = (await readFile(args.journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(events.length, 4);
      assert.equal(events[3].kind, 'dispatch');
      assert.equal(
        Buffer.from(proto.Query.encode(request).finish()).toString('base64'),
        events[2].queryBytes,
      );
      const payment = Transaction.fromBytes(
        proto.Transaction.encode(
          request.fileGetContents.header.payment,
        ).finish(),
      );
      assert.equal(payment.transactionId.toString(), args.input.transactionId);
      assert.equal(key.publicKey.verifyTransaction(payment), true);
      return proto.Response.decode(
        proto.Response.encode({
          fileGetContents: {
            header: {},
            fileContents: { fileID: { fileNum: '2001' }, contents },
          },
        }).finish(),
      );
    },
  );
  const observed = await readHfsContentsOnce(args);
  assert.equal(observed.kind, 'file_readback');
  assert.deepEqual(Buffer.from(observed.contents), contents);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.equal(signatures, 1);
  assert.equal(generated.mock.callCount(), 0);
  assert.deepEqual(
    await recoverHfsReadback(args.journalPath, args.input),
    observed,
  );
  assert.equal(dispatch.mock.callCount(), 1);
});

await test('lost paid query response remains unresolved on restart and never starts another query', async (t) => {
  const args = await fixture();
  const execute = t.mock.method(
    FileContentsQuery.prototype,
    'execute',
    async function (client) {
      await this._beforeExecute(client);
      await this._makeRequestAsync();
      throw Error('Response lost');
    },
  );
  assert.equal((await readHfsContentsOnce(args)).kind, 'unresolved');
  assert.equal(
    (await recoverHfsReadback(args.journalPath, args.input)).kind,
    'unresolved',
  );
  await assert.rejects(readHfsContentsOnce(args));
  assert.equal(execute.mock.callCount(), 1);
  const records = (await readFile(args.journalPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(records.length, 4);
  assert.equal(records[2].kind, 'signed_query');
});

await test('wrong file identity, byte encoding, body or readback configuration cannot authorize creation', async (t) => {
  for (const mutation of [
    { contents: Buffer.from(contents.toString('ascii'), 'hex') },
    { contents: Buffer.concat([contents, contents]) },
    { fileID: { fileNum: '2002' } },
  ]) {
    const args = await fixture();
    const execute = t.mock.method(
      FileContentsQuery.prototype,
      'execute',
      async function (client) {
        return answer(this, client, args, mutation);
      },
    );
    assert.equal((await readHfsContentsOnce(args)).kind, 'unresolved');
    assert.equal(
      (await recoverHfsReadback(args.journalPath, args.input)).kind,
      'unresolved',
    );
    execute.mock.restore();
  }
  const args = await fixture();
  t.mock.method(
    FileContentsQuery.prototype,
    'execute',
    async function (client) {
      return answer(this, client, args);
    },
  );
  assert.equal((await readHfsContentsOnce(args)).kind, 'file_readback');
  await assert.rejects(
    recoverHfsReadback(args.journalPath, {
      ...args.input,
      queryPaymentTinybar: '50001',
    }),
  );
  const original = await readFile(args.journalPath, 'utf8');
  const events = original.trim().split('\n').map(JSON.parse);
  events[2].querySha256 = '00'.repeat(32);
  await writeFile(
    args.journalPath,
    `${events.map(JSON.stringify).join('\n')}\n`,
  );
  await assert.rejects(recoverHfsReadback(args.journalPath, args.input));
  await writeFile(args.journalPath, original.slice(0, -1));
  await assert.rejects(recoverHfsReadback(args.journalPath, args.input));
});
