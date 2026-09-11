import { constants } from 'node:fs';
import { open, unlink, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicKey, TransactionId } from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import { parseTransaction } from 'viem';
import { prepareHfsCreation } from './creation.mjs';
import { submitHfsOnce, recoverHfsSubmission } from './submission.mjs';
import { readHfsContentsOnce, recoverHfsReadback } from './readback.mjs';

const FORMAT = 'ultratokenizer.hfs-controller.v1';
const WEIBARS_PER_TINYBAR = 10000000000n;
const ABORT_GAS_CUSHION_TINYBAR = 100000000n;
const MAX_JOURNAL_BYTES = 2097152;
const READBACK_MAX_AGE_SECONDS = 300;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => sha256(JSON.stringify(value));
const check = (value) => {
  if (!value)
    throw Error(
      'HFS controller state, configuration, operation identity or budget no longer matches its original plan.',
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
}
function hash(value) {
  check(
    typeof value === 'string' &&
      /^[0-9a-f]{64}$/.test(value) &&
      !/^0+$/.test(value),
  );
}
const POLICY_FIELDS = [
  'purpose',
  'chainId',
  'sender',
  'nonce',
  'creationHash',
  'maxGas',
  'maxFeePerGasWei',
  'maxTotalGasFeeWei',
];
const FEE_FIELDS = [
  'fileCreateMaxFeeTinybar',
  'fileAppendMaxFeeTinybar',
  'readbackMaxFeeTinybar',
  'readbackPaymentTinybar',
  'ethereumMaxFeeTinybar',
  'maxGasAllowanceTinybar',
  'totalBudgetTinybar',
];
async function derive(input, journalPath) {
  const config = plain(input, [
    'deploymentId',
    'signedTransaction',
    'creationPolicy',
    'payer',
    'node',
    'publicKey',
    'fileLifetimeSeconds',
    'fees',
  ]);
  hash(config.deploymentId);
  entity(config.payer);
  entity(config.node);
  check(config.payer !== config.node);
  config.publicKey = PublicKey.fromString(config.publicKey).toStringDer();
  config.creationPolicy = plain(config.creationPolicy, POLICY_FIELDS);
  config.fees = plain(config.fees, FEE_FIELDS);
  for (const field of FEE_FIELDS)
    quantity(config.fees[field], field === 'maxGasAllowanceTinybar');
  const lifetime = quantity(config.fileLifetimeSeconds);
  check(lifetime >= 3600n && lifetime <= 86400n);
  const builder = await prepareHfsCreation(
    config.signedTransaction,
    config.creationPolicy,
  );
  config.signedTransaction = config.signedTransaction.toLowerCase();
  const contents = Buffer.from(
    parseTransaction(config.signedTransaction).data.slice(2),
    'ascii',
  );
  check(contents.length === builder.summary.fileBytes);
  const gas =
    (BigInt(builder.summary.maximumGasFeeWei) + WEIBARS_PER_TINYBAR - 1n) /
    WEIBARS_PER_TINYBAR;
  const native =
    quantity(config.fees.fileCreateMaxFeeTinybar) +
    BigInt(builder.summary.fileChunks - 1) *
      quantity(config.fees.fileAppendMaxFeeTinybar) +
    quantity(config.fees.readbackMaxFeeTinybar) +
    quantity(config.fees.ethereumMaxFeeTinybar);
  const maximum =
    native +
    quantity(config.fees.readbackPaymentTinybar) +
    gas +
    quantity(config.fees.maxGasAllowanceTinybar, true) +
    ABORT_GAS_CUSHION_TINYBAR;
  check(maximum <= quantity(config.fees.totalBudgetTinybar));
  const plan = {
    format: FORMAT,
    purpose: 'test',
    chainId: '296',
    locationSha256: sha256(resolve(journalPath)),
    config,
    creation: builder.summary,
    contentsSha256: sha256(contents),
    budget: {
      unit: 'tinybar',
      nativeMaximumFees: native.toString(),
      readbackTransfer: config.fees.readbackPaymentTinybar,
      senderGasMaximum: gas.toString(),
      payerGasAllowance: config.fees.maxGasAllowanceTinybar,
      abortGasCushion: ABORT_GAS_CUSHION_TINYBAR.toString(),
      maximumFundingEnvelope: maximum.toString(),
      totalLimit: config.fees.totalBudgetTinybar,
      settledCostKnown: false,
    },
  };
  return { plan, builder, contents };
}
function steps(plan) {
  const result = [
    {
      kind: 'file_create',
      maximumCostTinybar: plan.config.fees.fileCreateMaxFeeTinybar,
    },
  ];
  for (let chunk = 1; chunk < plan.creation.fileChunks; chunk += 1)
    result.push({
      kind: 'file_append',
      chunk,
      maximumCostTinybar: plan.config.fees.fileAppendMaxFeeTinybar,
    });
  result.push({
    kind: 'readback',
    maximumCostTinybar: (
      quantity(plan.config.fees.readbackMaxFeeTinybar) +
      quantity(plan.config.fees.readbackPaymentTinybar)
    ).toString(),
  });
  result.push({
    kind: 'ethereum_create',
    maximumCostTinybar: (
      quantity(plan.config.fees.ethereumMaxFeeTinybar) +
      BigInt(plan.budget.senderGasMaximum) +
      quantity(plan.config.fees.maxGasAllowanceTinybar, true) +
      ABORT_GAS_CUSHION_TINYBAR
    ).toString(),
  });
  return result;
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
async function append(handle, events, body) {
  const value = {
    index: events.length,
    previousHash: events.at(-1)?.eventHash ?? '0'.repeat(64),
    body,
  };
  const event = { ...value, eventHash: digest(value) };
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
  events.push(event);
}
async function readEvents(handle) {
  const stat = await handle.stat();
  check(
    stat.isFile() &&
      stat.size > 0 &&
      stat.size <= MAX_JOURNAL_BYTES &&
      (stat.mode & 0o077) === 0,
  );
  const text = await boundedText(handle, MAX_JOURNAL_BYTES);
  check(text.endsWith('\n'));
  const parsed = text.slice(0, -1).split('\n').map(JSON.parse);
  check(parsed.length <= 140);
  const events = [];
  for (const entry of parsed) {
    const event = plain(entry, ['index', 'previousHash', 'body', 'eventHash']);
    check(
      event.index === events.length &&
        event.previousHash === (events.at(-1)?.eventHash ?? '0'.repeat(64)),
    );
    check(
      event.eventHash ===
        digest({
          index: event.index,
          previousHash: event.previousHash,
          body: event.body,
        }),
    );
    events.push(event);
  }
  return events;
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
function operationName(path, index) {
  return `${basename(path)}.step-${String(index).padStart(3, '0')}.jsonl`;
}
function bodyHash(transaction) {
  const entries = proto.TransactionList.decode(
    transaction.toBytes(),
  ).transactionList;
  check(entries.length === 1 && entries[0].signedTransactionBytes.length > 0);
  return sha256(
    proto.SignedTransaction.decode(entries[0].signedTransactionBytes).bodyBytes,
  );
}
function readbackInput(plan, attempt) {
  return {
    payer: plan.config.payer,
    node: plan.config.node,
    transactionId: attempt.transactionId,
    publicKey: plan.config.publicKey,
    fileId: attempt.fileId,
    maxFeeTinybar: plan.config.fees.readbackMaxFeeTinybar,
    queryPaymentTinybar: plan.config.fees.readbackPaymentTinybar,
    expectedBytes: plan.creation.fileBytes,
    contentsSha256: plan.contentsSha256,
  };
}
function transactionFor(state, attempt, fileContents = state.contents) {
  const { plan, builder } = state;
  const step = steps(plan)[attempt.step];
  const common = {
    payer: plan.config.payer,
    node: plan.config.node,
    transactionId: attempt.transactionId,
  };
  if (step.kind === 'file_create') {
    const id = TransactionId.fromString(attempt.transactionId);
    return builder.createFile({
      ...common,
      maxFeeTinybar: plan.config.fees.fileCreateMaxFeeTinybar,
      publicKey: plan.config.publicKey,
      expiresAt: (
        BigInt(id.validStart.seconds.toString()) +
        quantity(plan.config.fileLifetimeSeconds)
      ).toString(),
    });
  }
  if (step.kind === 'file_append')
    return builder.appendFile(step.chunk, attempt.fileId, {
      ...common,
      maxFeeTinybar: plan.config.fees.fileAppendMaxFeeTinybar,
    });
  if (step.kind === 'ethereum_create')
    return builder.createContract(attempt.fileId, fileContents, {
      ...common,
      maxFeeTinybar: plan.config.fees.ethereumMaxFeeTinybar,
      maxGasAllowanceTinybar: plan.config.fees.maxGasAllowanceTinybar,
    });
  return null;
}
function summarizeReadback(value) {
  return {
    kind: value.kind,
    assurance: value.assurance,
    transactionId: value.transactionId,
    nativeHash: value.nativeHash,
    fileId: value.fileId,
    contentsSha256: value.contentsSha256,
    observedAtUnix: value.observedAtUnix,
  };
}
function observed(plan, attempt, value) {
  const step = steps(plan)[attempt.step];
  check(value && value.transactionId === attempt.transactionId);
  if (step.kind === 'readback') {
    const result = plain(value, [
      'kind',
      'assurance',
      'transactionId',
      'nativeHash',
      'fileId',
      'contentsSha256',
      'observedAtUnix',
    ]);
    check(
      result.kind === 'file_readback' &&
        result.assurance === 'provider_observed' &&
        result.fileId === attempt.fileId &&
        result.contentsSha256 === plan.contentsSha256,
    );
    check(
      Number.isSafeInteger(result.observedAtUnix) && result.observedAtUnix > 0,
    );
    check(
      typeof result.nativeHash === 'string' &&
        /^[0-9a-f]{96}$/.test(result.nativeHash),
    );
    return result;
  }
  const result = plain(value, [
    'kind',
    'assurance',
    'transactionId',
    'nativeHash',
    'status',
    'consensusTimestamp',
    'fileId',
    'contractId',
  ]);
  check(
    result.kind === 'mirror_observation' &&
      result.assurance === 'provider_observed',
  );
  check(
    typeof result.nativeHash === 'string' &&
      /^[0-9a-f]{96}$/.test(result.nativeHash),
  );
  check(
    typeof result.consensusTimestamp === 'string' &&
      /^[1-9][0-9]*\.[0-9]{9}$/.test(result.consensusTimestamp),
  );
  const validStart = TransactionId.fromString(attempt.transactionId).validStart;
  const startNanos =
    BigInt(validStart.seconds.toString()) * 1000000000n +
    BigInt(validStart.nanos.toString());
  const consensusNanos = BigInt(result.consensusTimestamp.replace('.', ''));
  check(
    consensusNanos >= startNanos &&
      consensusNanos <= startNanos + 120000000000n,
  );
  check(
    typeof result.status === 'string' &&
      /^[A-Z][A-Z0-9_]{0,100}$/.test(result.status),
  );
  if (result.status === 'SUCCESS') {
    if (step.kind === 'ethereum_create') {
      entity(result.contractId);
      check(result.fileId === null);
    } else {
      entity(result.fileId);
      check(result.contractId === null);
      if (attempt.fileId !== null) check(result.fileId === attempt.fileId);
    }
  } else check(result.fileId === null && result.contractId === null);
  return result;
}
function successful(item) {
  return (
    item.observation &&
    (item.observation.kind === 'file_readback' ||
      item.observation.status === 'SUCCESS')
  );
}
async function stateFrom(events, journalPath, expectedPlanSha256) {
  hash(expectedPlanSha256);
  const first = plain(events[0].body, ['kind', 'plan', 'planSha256']);
  check(
    first.kind === 'initialized' &&
      first.planSha256 === expectedPlanSha256 &&
      digest(first.plan) === expectedPlanSha256,
  );
  const derived = await derive(first.plan.config, journalPath);
  check(digest(derived.plan) === expectedPlanSha256);
  const state = { ...derived, events, attempts: [], reserved: 0n };
  const defined = steps(state.plan);
  let fileId = null;
  for (const event of events.slice(1)) {
    if (event.body.kind === 'attempt') {
      const attempt = plain(event.body, [
        'kind',
        'step',
        'operationKind',
        'journalName',
        'transactionId',
        'fileId',
        'bodySha256',
        'maximumCostTinybar',
      ]);
      check(
        state.attempts.every(successful) &&
          attempt.step === state.attempts.length &&
          attempt.step < defined.length,
      );
      check(
        attempt.operationKind === defined[attempt.step].kind &&
          attempt.journalName === operationName(journalPath, attempt.step) &&
          attempt.maximumCostTinybar ===
            defined[attempt.step].maximumCostTinybar &&
          attempt.fileId === fileId,
      );
      check(
        typeof attempt.transactionId === 'string' &&
          /^0\.0\.[1-9][0-9]*@[1-9][0-9]*\.[0-9]{9}$/.test(
            attempt.transactionId,
          ),
      );
      const nativeId = TransactionId.fromString(attempt.transactionId);
      check(
        nativeId.toString() === attempt.transactionId &&
          nativeId.accountId.toString() === state.plan.config.payer,
      );
      check(
        state.attempts.every(
          (item) => item.attempt.transactionId !== attempt.transactionId,
        ),
      );
      const transaction = transactionFor(state, attempt);
      check(
        attempt.bodySha256 ===
          (transaction
            ? bodyHash(transaction)
            : digest(readbackInput(state.plan, attempt))),
      );
      state.reserved += quantity(attempt.maximumCostTinybar);
      check(
        state.reserved <= quantity(state.plan.budget.maximumFundingEnvelope) &&
          state.reserved <= quantity(state.plan.budget.totalLimit),
      );
      state.attempts.push({ attempt, observation: null });
    } else {
      const saved = plain(event.body, ['kind', 'step', 'observation']);
      const item = state.attempts.at(-1);
      check(
        saved.kind === 'observed' &&
          item &&
          !item.observation &&
          saved.step === item.attempt.step,
      );
      item.observation = observed(state.plan, item.attempt, saved.observation);
      if (
        item.attempt.operationKind === 'file_create' &&
        item.observation.status === 'SUCCESS'
      )
        fileId = item.observation.fileId;
    }
  }
  state.fileId = fileId;
  return state;
}
async function operationExists(path) {
  try {
    const stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink());
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function checkNativeRecord(state, item, path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    check(
      stat.isFile() &&
        stat.size > 0 &&
        stat.size <= 32768 &&
        (stat.mode & 0o077) === 0,
    );
    const text = await boundedText(file, 32768);
    check(text.endsWith('\n'));
    const record = JSON.parse(text.split('\n')[0]);
    check(
      record.transactionId === item.attempt.transactionId &&
        record.publicKey === state.plan.config.publicKey &&
        record.kind === item.attempt.operationKind &&
        record.node === state.plan.config.node,
    );
    const bytes = Buffer.from(record.signedBytes, 'base64');
    const entries = proto.TransactionList.decode(bytes).transactionList;
    check(entries.length === 1);
    check(
      sha256(
        proto.SignedTransaction.decode(entries[0].signedTransactionBytes)
          .bodyBytes,
      ) === item.attempt.bodySha256,
    );
  } finally {
    await file.close();
  }
}
async function recoverItem(state, item, journalPath) {
  const path = join(dirname(journalPath), item.attempt.journalName);
  if (!(await operationExists(path)))
    return { kind: 'unresolved', transactionId: item.attempt.transactionId };
  if (item.attempt.operationKind === 'readback')
    return recoverHfsReadback(path, readbackInput(state.plan, item.attempt));
  await checkNativeRecord(state, item, path);
  return recoverHfsSubmission(path);
}
function summary(state, kind, extra = {}) {
  return Object.freeze({
    kind,
    assurance: 'local_controller_state',
    observationAssurance: state.attempts.some((item) => item.observation)
      ? 'provider_observed'
      : null,
    planSha256: state.events[0].body.planSha256,
    completedSteps: state.attempts.filter(successful).length,
    totalSteps: steps(state.plan).length,
    reservedMaximumTinybar: state.reserved.toString(),
    totalBudgetTinybar: state.plan.budget.totalLimit,
    fileId: state.fileId,
    predictedContractAddress: state.plan.creation.contractAddress,
    chainGraphAdmitted: false,
    settledCostKnown: false,
    ...extra,
  });
}

/** Offline initialization fixes every policy/fee component and the journal location. */
export async function initializeHfsController({ journalPath, input }) {
  const { plan } = await derive(input, journalPath);
  return lock(journalPath, async () => {
    const handle = await open(journalPath, 'wx', 0o600);
    try {
      const events = [];
      const planSha256 = digest(plan);
      await append(handle, events, { kind: 'initialized', plan, planSha256 });
      await syncDirectory(journalPath);
      return Object.freeze({
        kind: 'initialized',
        planSha256,
        totalSteps: steps(plan).length,
        budget: Object.freeze(plan.budget),
        chainGraphAdmitted: false,
      });
    } finally {
      await handle.close();
    }
  });
}

/** Advance one new operation, or recover the one already attempted. Never re-sign a step. */
export async function advanceHfsController({
  journalPath,
  expectedPlanSha256,
  signer,
}) {
  return lock(journalPath, async () => {
    const handle = await open(
      journalPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const events = await readEvents(handle);
      const state = await stateFrom(events, journalPath, expectedPlanSha256);
      const deadline = Date.now() + 120000;
      let readback = null;
      for (const item of state.attempts.filter((value) => value.observation)) {
        if (Date.now() >= deadline)
          return summary(state, 'unresolved', {
            reason: 'observation_deadline',
          });
        const current = await recoverItem(state, item, journalPath);
        if (current.kind === 'unresolved')
          return summary(state, 'unresolved', {
            reason: 'previous_observation_unavailable',
            step: item.attempt.step,
          });
        const reduced =
          current.kind === 'file_readback'
            ? summarizeReadback(current)
            : current;
        check(
          digest(observed(state.plan, item.attempt, reduced)) ===
            digest(item.observation),
        );
        if (!successful(item))
          return summary(state, 'failed', {
            step: item.attempt.step,
            status: item.observation.status,
          });
        if (current.kind === 'file_readback') readback = current;
      }
      if (
        state.attempts.length === steps(state.plan).length &&
        state.attempts.every(successful)
      ) {
        return summary(state, 'deployment_observed', {
          contractId: state.attempts.at(-1).observation.contractId,
        });
      }
      const pending = state.attempts.find((item) => !item.observation);
      if (pending) {
        const current = await recoverItem(state, pending, journalPath);
        if (current.kind === 'unresolved')
          return summary(state, 'unresolved', { step: pending.attempt.step });
        const reduced =
          current.kind === 'file_readback'
            ? summarizeReadback(current)
            : current;
        const accepted = observed(state.plan, pending.attempt, reduced);
        await append(handle, events, {
          kind: 'observed',
          step: pending.attempt.step,
          observation: accepted,
        });
        return summary(
          await stateFrom(events, journalPath, expectedPlanSha256),
          accepted.status && accepted.status !== 'SUCCESS'
            ? 'failed'
            : 'step_recovered',
          { step: pending.attempt.step },
        );
      }
      check(typeof signer === 'function' && Date.now() < deadline);
      const index = state.attempts.length;
      const step = steps(state.plan)[index];
      if (index > 0) {
        const createdId = TransactionId.fromString(
          state.attempts[0].attempt.transactionId,
        );
        check(
          BigInt(Math.floor(Date.now() / 1000)) + 120n <
            BigInt(createdId.validStart.seconds.toString()) +
              quantity(state.plan.config.fileLifetimeSeconds),
        );
      }
      if (step.kind === 'ethereum_create') {
        check(
          readback &&
            Math.floor(Date.now() / 1000) - readback.observedAtUnix <=
              READBACK_MAX_AGE_SECONDS &&
            readback.observedAtUnix <= Math.floor(Date.now() / 1000),
        );
        check(Buffer.from(readback.contents).equals(state.contents));
      }
      const transactionId = TransactionId.generate(
        state.plan.config.payer,
      ).toString();
      check(
        state.attempts.every(
          (item) => item.attempt.transactionId !== transactionId,
        ),
      );
      const attempt = {
        kind: 'attempt',
        step: index,
        operationKind: step.kind,
        journalName: operationName(journalPath, index),
        transactionId,
        fileId: state.fileId,
        bodySha256: '',
        maximumCostTinybar: step.maximumCostTinybar,
      };
      const transaction = transactionFor(
        state,
        attempt,
        readback?.contents ?? state.contents,
      );
      attempt.bodySha256 = transaction
        ? bodyHash(transaction)
        : digest(readbackInput(state.plan, attempt));
      const path = join(dirname(journalPath), attempt.journalName);
      check(!(await operationExists(path)));
      check(
        state.reserved + quantity(attempt.maximumCostTinybar) <=
          quantity(state.plan.budget.totalLimit),
      );
      await append(handle, events, attempt);
      // This barrier reserves the unique step before any signer or network operation.
      const attempted = await stateFrom(
        events,
        journalPath,
        expectedPlanSha256,
      );
      let current;
      try {
        current =
          step.kind === 'readback'
            ? await readHfsContentsOnce({
                journalPath: path,
                input: readbackInput(state.plan, attempt),
                signer,
              })
            : await submitHfsOnce({
                journalPath: path,
                transaction,
                publicKey: state.plan.config.publicKey,
                signer,
              });
      } catch {
        return summary(attempted, 'unresolved', { step: index });
      }
      if (current.kind === 'unresolved')
        return summary(attempted, 'unresolved', { step: index });
      const reduced =
        current.kind === 'file_readback' ? summarizeReadback(current) : current;
      const accepted = observed(state.plan, attempt, reduced);
      await append(handle, events, {
        kind: 'observed',
        step: index,
        observation: accepted,
      });
      const completed = await stateFrom(
        events,
        journalPath,
        expectedPlanSha256,
      );
      if (accepted.status && accepted.status !== 'SUCCESS')
        return summary(completed, 'failed', {
          step: index,
          status: accepted.status,
        });
      return summary(
        completed,
        step.kind === 'ethereum_create'
          ? 'deployment_observed'
          : 'step_succeeded',
        {
          step: index,
          ...(step.kind === 'ethereum_create'
            ? { contractId: accepted.contractId }
            : {}),
        },
      );
    } finally {
      await handle.close();
    }
  });
}
