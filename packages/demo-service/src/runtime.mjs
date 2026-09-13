import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  stringToHex,
  encodeAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseDuplicateFreeJson,
  getIssuanceRequestDigest,
  getClaimUsageId,
} from '../../../dist/domain/src/index.js';
import { openInstitutionLedger } from '../../institution/dist/index.js';
import {
  createIssuerClient,
  parseDeploymentConfig,
  parseClaimProofExport,
  parseIssuanceBundle,
  ISSUANCE_GATE_ABI,
  SP1_VERIFIER_ABI,
} from '../../issuance/dist/index.js';
import {
  check,
  confined,
  readOwned,
  readJson,
  writeNew,
  privateDirectory,
  runJson,
  sha256,
  randomId,
  ServiceError,
} from './io.mjs';
import { credential, issuerProvider } from './issuer-provider.mjs';
import { checkBudgetReview } from './budget.mjs';

/** Concrete local adapter. Configuration is operator-owned; request bodies never choose tools or pins. */
/**
 * Classifies a failed reservation attempt. `capacity_exceeded` comes only from
 * the read-only preflight inside `openPreparedReservation`, which runs before
 * anything is signed or broadcast, so the issuer nonce is untouched and the
 * next document may still reserve. Every other failure may have left a
 * transaction in flight, and the caller must stop using that nonce stream.
 */
export function reservationFailure(error) {
  return error?.code === 'capacity_exceeded'
    ? 'capacity_exceeded'
    : 'reservation_uncertain';
}

export class RuntimeAdapter {
  static async load(root, configPath) {
    const config = await readJson(configPath, 32 * 1024);
    check(
      config.format === 'ultratokenizer.demo-service.v1' &&
        typeof config.operationsEnabled === 'boolean',
      'service_unavailable',
      503,
    );
    const url = new URL(config.origin);
    check(
      url.hostname === '127.0.0.1' &&
        url.protocol === 'http:' &&
        url.origin === config.origin,
      'service_unavailable',
      503,
    );
    check(
      Number.isInteger(config.port) &&
        config.port >= 1024 &&
        config.port <= 65535,
      'service_unavailable',
      503,
    );
    check(
      /^[1-9][0-9]{0,11}$/.test(config.maxReservationFeeTinybar),
      'service_unavailable',
      503,
    );
    const runtime = new RuntimeAdapter(root, config);
    await runtime.loadInputs();
    return runtime;
  }
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.sources = new Map();
    this.inspected = new Set();
    this.reservationTail = Promise.resolve();
    this.reservationUncertain = false;
  }
  path(name) {
    return confined(this.root, this.config[name]);
  }
  async loadInputs() {
    this.deployment = parseDeploymentConfig(
      await readJson(this.path('deploymentPath'), 64 * 1024),
    );
    this.policy = this.deployment.auditPolicy;
    check(this.policy.chainId === '296', 'service_unavailable', 503);
    this.reader = createPublicClient({
      transport: http(this.deployment.rpcUrl, {
        timeout: 15000,
        retryCount: 0,
        maxResponseBodySize: 512 * 1024,
        fetchOptions: { credentials: 'omit', redirect: 'error' },
      }),
      cacheTime: 0,
    });
    this.program = parseDuplicateFreeJson(
      (
        await readOwned(this.path('programManifestPath'), 64 * 1024, false)
      ).toString('utf8'),
      64 * 1024,
    );
    check(
      this.program.programVKey === this.policy.programVKey &&
        this.program.profileVersion === 2,
      'service_unavailable',
      503,
    );
    const discovery = await readJson(this.path('discoveryPath'), 32 * 1024);
    check(
      discovery.format === 'ultratokenizer.discovery.v1' &&
        discovery.issuerId === this.policy.issuerId &&
        getAddress(discovery.gate) === this.policy.gate,
      'service_unavailable',
      503,
    );
    const identity = discovery.entries.find((entry) => entry.role === 'issuer');
    check(
      identity && /^[0-9]+$/.test(identity.agentId),
      'service_unavailable',
      503,
    );
    check(
      typeof this.config.issuerLabel === 'string' &&
        this.config.issuerLabel.length > 0 &&
        this.config.issuerLabel.length <= 120 &&
        ![...this.config.issuerLabel].some(
          (character) => character.codePointAt(0) < 32,
        ),
      'service_unavailable',
      503,
    );
    this.issuer = {
      label: this.config.issuerLabel,
      issuerId: this.policy.issuerId,
      wallet: this.policy.issuerAddress,
      agentId: identity.agentId,
      identityRegistry: getAddress(discovery.identityRegistry.address),
      selected: true,
    };
    const policyText = (
      await readOwned(this.path('policyTermsPath'), 12 * 1024)
    ).toString('utf8');
    const rightsText = (
      await readOwned(this.path('rightsTermsPath'), 12 * 1024)
    ).toString('utf8');
    this.terms = {
      policy: { text: policyText, hash: keccak256(stringToHex(policyText)) },
      rights: { text: rightsText, hash: keccak256(stringToHex(rightsText)) },
    };
    const manifest = await readJson(this.path('manifestPath'), 64 * 1024);
    check(
      manifest.format === 'ultratokenizer.demo-batch.v1' &&
        manifest.runs.length === 10,
      'service_unavailable',
      503,
    );
    for (const run of manifest.runs) {
      check(
        /^(0[1-9]|10)$/.test(run.number) &&
          /^[0-9a-f]{64}$/.test(run.fileSha256),
        'service_unavailable',
        503,
      );
      const source = await readJson(
        join(dirname(this.path('manifestPath')), run.number, 'source.json'),
        16 * 1024,
      );
      check(
        source.fileSha256 === run.fileSha256 &&
          source.signerFingerprint === run.signerFingerprint &&
          source.claim.capacityMilligrams === '1000',
        'service_unavailable',
        503,
      );
      check(
        source.claim.sourceId === this.policy.sourceId &&
          source.claim.issuerId === this.policy.issuerId &&
          `0x${source.signerFingerprint}` ===
            this.policy.sourceSignerFingerprint,
        'source_not_admitted',
        503,
      );
      check(
        getClaimUsageId({
          sourceId: source.claim.sourceId,
          claimId: source.claim.claimId,
        }) === source.claimUsageId && source.claimUsageId === run.claimUsageId,
        'invalid_document',
        503,
      );
      check(!this.sources.has(run.fileSha256), 'service_unavailable', 503);
      this.sources.set(run.fileSha256, {
        documentId: run.fileSha256,
        name: `Demo ${run.number} signed gold allocation`,
        amountMilligrams: '1000',
        recipient: getAddress(source.claim.holder),
        issuerId: source.claim.issuerId,
        sourceId: source.claim.sourceId,
        sourceSignerFingerprint: `0x${source.signerFingerprint}`,
        profile: 'ultratokenizer-synthetic-gold-v2',
        sha256: `0x${run.fileSha256}`,
        source,
        run,
        pdfPath: confined(this.root, run.pdfPath),
        draftPath: join(
          dirname(this.path('manifestPath')),
          run.number,
          'request.draft.json',
        ),
      });
    }
  }
  async readiness() {
    if (!this.config.budgetReviewPath)
      return { canStart: false, blocker: 'proof_provider_unresolved' };
    try {
      await checkBudgetReview(
        this.root,
        this.config,
        Math.floor(Date.now() / 1000),
      );
    } catch {
      return { canStart: false, blocker: 'operations_disabled' };
    }
    const network = this.config.network;
    if (
      !this.config.operationsEnabled ||
      !network?.privateStdinEnabled ||
      !network?.disclosureApproved ||
      !Number.isSafeInteger(network.approvalValidUntilUnix) ||
      network.approvalValidUntilUnix <= Math.floor(Date.now() / 1000)
    )
      return { canStart: false, blocker: 'operations_disabled' };
    return { canStart: true };
  }
  async configuration() {
    let checked = false;
    let blockNumber;
    try {
      check((await this.reader.getChainId()) === 296, 'deployment_unavailable');
      const block = await this.reader.getBlock();
      const [code, policy, rights] = await Promise.all([
        this.reader.getCode({
          address: this.policy.gate,
          blockNumber: block.number,
        }),
        this.reader.readContract({
          address: this.policy.gate,
          abi: ISSUANCE_GATE_ABI,
          functionName: 'policies',
          args: [this.policy.issuerId, BigInt(this.policy.policyVersion)],
          blockNumber: block.number,
        }),
        this.reader.readContract({
          address: this.policy.gate,
          abi: ISSUANCE_GATE_ABI,
          functionName: 'rights',
          args: [this.policy.issuerId, BigInt(this.policy.rightsVersion)],
          blockNumber: block.number,
        }),
      ]);
      checked =
        !!code &&
        keccak256(code) === this.deployment.gateCodeHash &&
        policy[3] === this.terms.policy.hash &&
        rights[3] === this.terms.rights.hash &&
        !policy[4] &&
        !rights[4] &&
        policy[1] === this.policy.sourceId &&
        getAddress(rights[0]) === this.policy.token &&
        (await this.reader.getBlock({ blockNumber: block.number })).hash ===
          block.hash;
      if (checked) blockNumber = String(block.number);
    } catch {
      /* Never claim chain-checked terms during an RPC outage. */
    }
    let readiness = await this.readiness();
    if (!checked && readiness.canStart)
      readiness = { canStart: false, blocker: 'deployment_unavailable' };
    return {
      issuer: this.issuer,
      terms: {
        ...this.terms,
        checked,
        ...(blockNumber ? { blockNumber } : {}),
      },
      readiness,
    };
  }
  async assertOperationsEnabled() {
    const state = await this.configuration();
    check(state.readiness.canStart, state.readiness.blocker);
  }
  async source(id) {
    const source = this.sources.get(id);
    check(source && this.inspected.has(id), 'unsupported_document', 404);
    return source;
  }
  async inspect(id, bytes) {
    const source = this.sources.get(id);
    check(source, 'unsupported_document', 415);
    const actual = await readOwned(source.pdfPath, 256 * 1024);
    check(
      sha256(actual) === id && actual.equals(bytes),
      'invalid_document',
      400,
    );
    const result = await runJson(
      this.path('claimRunnerPath'),
      [
        'native',
        source.pdfPath,
        source.draftPath,
        source.source.signerFingerprint,
      ],
      { timeout: 30000 },
    );
    check(
      result.status === 'claim_verified' &&
        result.zkProof === false &&
        result.requestDigest === source.run.requestDigest,
      'invalid_document',
      400,
    );
    this.inspected.add(id);
    const {
      name,
      amountMilligrams,
      recipient,
      issuerId,
      sourceId,
      sourceSignerFingerprint,
      profile,
      sha256: hash,
    } = source;
    return {
      name,
      amountMilligrams,
      recipient,
      issuerId,
      sourceId,
      sourceSignerFingerprint,
      profile,
      sha256: hash,
    };
  }
  async draft(source, fields) {
    return {
      schemaVersion: '1',
      action: 'ISSUE',
      requestId: fields.requestId,
      chainId: this.policy.chainId,
      gate: this.policy.gate,
      token: this.policy.token,
      recipient: fields.recipient,
      amount: source.amountMilligrams,
      unit: 'XAU_MILLIGRAM',
      issuerId: this.policy.issuerId,
      reservationId: fields.reservationId,
      claimCommitment: source.source.claimCommitment,
      claimUsageId: source.source.claimUsageId,
      policyVersion: this.policy.policyVersion,
      rightsVersion: this.policy.rightsVersion,
      nonce: fields.nonce,
      validUntil: String(
        Math.min(
          fields.now + 48 * 3600,
          Number(source.source.claim.validUntil),
        ),
      ),
    };
  }
  async verifyDraft(source, request) {
    const folder = join(this.path('storePath'), '.inspection');
    await privateDirectory(folder);
    const path = join(
      folder,
      `${getIssuanceRequestDigest(request).slice(2)}.json`,
    );
    await writeNew(path, request);
    const result = await runJson(
      this.path('claimRunnerPath'),
      ['native', source.pdfPath, path, source.source.signerFingerprint],
      { timeout: 30000 },
    );
    const expected = encodeAbiParameters(
      [
        'uint256',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
      ].map((type) => ({ type })),
      [
        2n,
        getIssuanceRequestDigest(request),
        source.sourceSignerFingerprint,
        source.sourceId,
        request.claimUsageId,
        request.claimCommitment,
        BigInt(source.source.claim.validUntil),
      ],
    );
    check(
      result.status === 'claim_verified' &&
        result.zkProof === false &&
        result.publicValues === expected,
      'invalid_document',
    );
    return result;
  }
  reserve(job, folder) {
    // One issuer wallet has one nonce stream, even when several documents are active.
    const work = this.reservationTail.then(() => this.reserveOnce(job, folder));
    this.reservationTail = work.catch(() => {});
    return work;
  }
  async reserveOnce(job, folder) {
    check(!this.reservationUncertain, 'reservation_uncertain');
    await this.assertOperationsEnabled();
    const source = this.sources.get(job.documentId);
    const ledger = openInstitutionLedger({ path: this.path('ledgerPath') });
    try {
      const right = ledger.getRight(source.source.rightId);
      check(
        right.claimUsageId === job.request.claimUsageId &&
          right.holder === job.request.recipient &&
          right.milligrams === job.request.amount,
        'ledger_not_ready',
      );
      ledger.reserve({ rightId: right.rightId, request: job.request });
    } finally {
      ledger.close();
    }
    const client = createIssuerClient({
      provider: issuerProvider(this, job, folder),
      deployment: this.deployment,
    });
    try {
      const hash = await client.openPreparedReservation(
        job.prepared,
        job.holderSignature,
      );
      await writeNew(join(folder, 'reservation-hash.json'), {
        transactionHash: hash,
      });
      const result = await client.waitPreparedReservation(job.prepared, hash);
      await writeNew(join(folder, 'reservation.json'), result);
      return result;
    } catch (error) {
      const code = reservationFailure(error);
      if (code === 'reservation_uncertain') this.reservationUncertain = true;
      throw new ServiceError(code);
    }
  }
  async prove(job, folder, update) {
    await this.assertOperationsEnabled();
    const source = this.sources.get(job.documentId);
    const prefix = join(folder, 'job');
    const preparationPath = `${prefix}.sp1-network-preparation.json`;
    const stagePath = `${prefix}.sp1-network-staging.jsonl`;
    const quotePath = `${prefix}.sp1-network-quote.json`;
    const settingsPath = `${prefix}.sp1-network-submission.json`;
    const requestJournal = `${prefix}.sp1-network-request.jsonl`;
    const budgetPath = confined(this.root, this.config.network.budgetPath);
    const requestPath = join(folder, 'request.json');
    await writeNew(requestPath, job.request);
    const review = {
      schemaVersion: 2,
      purpose: 'authorized-synthetic-demo-job-proof',
      sourceKind: 'synthetic-signed-pdf-capsule',
      synthetic: true,
      productionApproved: false,
      chainId: '296',
      gate: job.request.gate.toLowerCase(),
      token: job.request.token.toLowerCase(),
      recipient: job.request.recipient.toLowerCase(),
      issuerId: job.request.issuerId,
      sourceId: source.sourceId,
      amountMilligrams: '1000',
      signerFingerprint: source.source.signerFingerprint,
      pdfSha256: job.documentId,
      requestJsonSha256: sha256(await readOwned(requestPath, 16 * 1024)),
      requestDigest: job.requestDigest,
    };
    const reviewPath = join(folder, 'review.json');
    await writeNew(reviewPath, review);
    const reviewHash = sha256(await readOwned(reviewPath, 16 * 1024));
    await update('preparing_proof');
    await runJson(this.path('claimRunnerPath'), [
      'network-prepare-reviewed-synthetic',
      this.path('elfPath'),
      this.path('programManifestPath'),
      reviewPath,
      reviewHash,
      source.pdfPath,
      requestPath,
      preparationPath,
    ]);
    await this.assertOperationsEnabled();
    const key = await credential(this.root, this.config.network.credential);
    check(
      privateKeyToAccount(key).address.toLowerCase() ===
        this.config.network.requesterAddress.toLowerCase(),
      'operations_disabled',
    );
    const env = { NETWORK_PRIVATE_KEY: key };
    const command = (args, options = {}) =>
      runJson(this.path('networkRequesterPath'), args, options);
    await update('staging');
    await command(
      [
        'stage-reviewed-synthetic',
        preparationPath,
        this.config.network.requesterAddress,
        this.path('elfPath'),
        stagePath,
        reviewPath,
        reviewHash,
        source.pdfPath,
        requestPath,
      ],
      { env },
    );
    await command(
      [
        'quote',
        preparationPath,
        this.config.network.requesterAddress,
        quotePath,
      ],
      { env },
    );
    const quote = await readJson(quotePath);
    const remaining =
      Math.min(
        Number(job.request.validUntil),
        this.config.network.approvalValidUntilUnix,
      ) -
      Math.floor(Date.now() / 1000) -
      600;
    const seconds = Math.min(
      this.config.network.proofDeadlineSeconds,
      remaining,
    );
    check(
      Number.isSafeInteger(seconds) && seconds >= 300 && seconds <= 14400,
      'preparation_failed',
    );
    const settings = {
      schemaVersion: 1,
      quoteId: quote.quoteId,
      quoteFileSha256: sha256(await readOwned(quotePath)),
      stagingJournalSha256: sha256(await readOwned(stagePath)),
      deadlineUnix: quote.observedAtUnix + seconds,
      minAuctionPeriodSeconds: this.config.network.minAuctionPeriodSeconds,
      proverWhitelist: this.config.network.proverWhitelist,
    };
    await writeNew(settingsPath, settings);
    // Reuse the configured immutable budget. This service never creates or resets one.
    await command([
      'prepare-request',
      preparationPath,
      quotePath,
      stagePath,
      settingsPath,
      budgetPath,
      requestJournal,
    ]);
    await this.assertOperationsEnabled();
    await update('queued');
    try {
      await command(['submit-request', requestJournal, budgetPath], { env });
    } catch {
      throw new ServiceError('proof_request_uncertain');
    }
    let observed;
    while (true) {
      observed = await command(['recover-request', requestJournal]);
      if (observed.proofAvailable === true) break;
      if (
        observed.deadlinePassed === true ||
        Math.floor(Date.now() / 1000) >= settings.deadlineUnix
      )
        throw new ServiceError('proof_deadline_elapsed');
      await update(observed.executionStatus === 2 ? 'proving' : 'queued');
      await delay(15000);
    }
    await update('proof_ready');
    const raw = `${prefix}-raw.sp1-network-proof`,
      normalized = `${prefix}-normalized.sp1-network-proof`,
      receipt = `${prefix}-retrieved.sp1-network-submission.json`;
    await command([
      'retrieve-proof',
      requestJournal,
      sha256(await readOwned(requestJournal)),
      confined(this.root, this.config.network.originAdmissionPath),
      raw,
      normalized,
      receipt,
    ]);
    const retrieval = await readJson(receipt);
    const preparation = await readJson(preparationPath);
    check(
      retrieval.status === 'downloaded_unverified' &&
        retrieval.programVKey === this.program.programVKey &&
        retrieval.publicValuesSha256 ===
          sha256(Buffer.from(preparation.publicValues.slice(2), 'hex')),
      'proof_invalid',
    );
    check(
      sha256(await readOwned(normalized, 1024 * 1024)) ===
        retrieval.normalizedSha256,
      'proof_invalid',
    );
    check(
      sha256(await readOwned(this.path('elfPath'), 32 * 1024 * 1024, false)) ===
        this.program.elfSha256,
      'proof_invalid',
    );
    const exported = await runJson(this.path('claimRunnerPath'), [
      'export-groth16',
      this.path('elfPath'),
      requestPath,
      normalized,
      this.program.programVKey,
    ]);
    const proof = parseClaimProofExport(exported);
    check(
      getIssuanceRequestDigest(proof.request) === job.requestDigest &&
        proof.publicValues === preparation.publicValues,
      'proof_invalid',
    );
    const block = await this.reader.getBlock();
    const code = await this.reader.getCode({
      address: this.policy.verifierAddress,
      blockNumber: block.number,
    });
    check(
      code && keccak256(code) === this.policy.verifierCodeHash,
      'proof_invalid',
    );
    await this.reader.readContract({
      address: this.policy.verifierAddress,
      abi: SP1_VERIFIER_ABI,
      functionName: 'verifyProof',
      args: [proof.programVKey, proof.publicValues, proof.proofBytes],
      blockNumber: block.number,
    });
    check(
      (await this.reader.getBlock({ blockNumber: block.number })).hash ===
        block.hash,
      'proof_invalid',
    );
    await writeNew(join(folder, 'verified-proof.json'), exported);
    return exported;
  }
  async permit(job, folder) {
    await this.assertOperationsEnabled();
    const nonce = BigInt(`0x${randomId()}`).toString();
    const client = createIssuerClient({
      provider: issuerProvider(this, job, folder, { permitNonce: nonce }),
      deployment: this.deployment,
    });
    try {
      const bundle = parseIssuanceBundle(
        await client.signPermit(job.proof, job.reservation.transactionHash, {
          nonce,
          validForSeconds: 600,
        }),
      );
      check(
        getIssuanceRequestDigest(bundle.request) === job.requestDigest,
        'proof_invalid',
      );
      await writeNew(join(folder, `permit-${nonce}.bundle.json`), bundle);
      return bundle;
    } catch {
      throw new ServiceError('issuer_unavailable');
    }
  }
}
