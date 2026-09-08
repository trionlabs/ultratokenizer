export type ModuleId =
  | 'client'
  | 'evidence'
  | 'prover'
  | 'institution'
  | 'registry'
  | 'gate'
  | 'token'
  | 'audit';
export type BlueprintModule = {
  id: ModuleId;
  number: string;
  title: string;
  short: string;
  zone: string;
  owner: string;
  purpose: string;
  input: string;
  output: string;
  state: string;
  guard: string;
  failure: string;
  acceptance: string;
  current: string;
  plannedPath: string;
};
// Eight logical boundaries; several contain separate, explicitly named runtimes.
// Status describes checked-in implementation, never a deployment attestation.
export const modules: BlueprintModule[] = [
  {
    id: 'client',
    number: '01',
    title: 'Request & coordination',
    short: 'Svelte session → authenticated API → durable tracking.',
    zone: 'Browser / edge',
    owner: 'Browser session; API Worker; one SQLite Durable Object per request',
    purpose:
      'Keep presentation separate from authenticated request tracking. The API validates ownership; a per-request object persists lifecycle transitions and alarms that reconcile a wallet-supplied transaction hash.',
    input:
      'Browser: synthetic request and disclosure choices. API: short-lived access token, canonical request and holder EIP-712 signature; later, a transaction hash.',
    output:
      'Browser preview state; separately, subject-owned tracking state and a bounded transition history. Confirmed means a matching gate event was observed through configured RPC.',
    state:
      'The Svelte session is in memory. SQLite stores public request fields, an ownership digest and observation state. Private PDFs, witnesses, access tokens and holder signatures are not persisted at the edge.',
    guard:
      'The API requires configured identity keys, exact origin, holder ownership and bounded input. Alarms persist a recovery lease before RPC and fence late responses. No API route signs, submits or retries a mint.',
    failure:
      'RPC uncertainty preserves the request. Exhausted observation retries require authenticated reconciliation. Stopping tracking does not revoke a signature or release a reservation.',
    acceptance:
      'Concurrent registration is idempotent; another subject is denied; SQL/alarm rollback and process restart preserve recovery. A matching event establishes observation, not independent proof or issuer authority.',
    current:
      'Svelte preview and authenticated Worker/SQLite implementation have local tests. They are separate integrations: the preview has no wallet/API submission flow. Worker trust configuration is unset and deployment acceptance remains pending.',
    plannedPath:
      'apps/web/src/lib/application/preview-session.ts · workers/issuance/src/{index,auth,coordinator,chain-observer}.ts',
  },
  {
    id: 'evidence',
    number: '02',
    title: 'Signed claim evidence',
    short: 'Strict signed bytes → one authenticated gold claim.',
    zone: 'Private local input',
    owner: 'Rust PDF verifier and versioned synthetic claim profile',
    purpose:
      'Authenticate a restricted RSA-SHA256 signed PDF and its fixed gold capsule. Derive a source/issuer/claim identity and bind the holder, commitment and requested amount to the canonical request.',
    input:
      'Local PDF, approved signer fingerprint and canonical request. The capsule contains private capacity, holder, issuer, source, claim ID, unit and expiry.',
    output:
      'Validated private witness and seven public claim words. Requested amount is public; the full signed capacity stays private.',
    state:
      'The document remains in the local Rust process. Neither the browser preview nor the edge API accepts personal PDFs. Source claim IDs must be stable and suitably unpredictable.',
    guard:
      'Reject unsigned revisions, ambiguous signature gaps, unsupported CMS shapes, duplicate capsule markers, wrong holder/issuer, unit mismatch and amount above signed capacity.',
    failure:
      'Unsupported or malformed evidence stops execution. The signature-only 96-byte profile cannot satisfy the distinct 224-byte issuance claim profile.',
    acceptance:
      'Native and SP1 guest rejection tests cover mutations; Rust request parsing agrees with canonical TypeScript vectors. Signed-byte authentication does not establish PDF rendering semantics or physical backing.',
    current:
      'Restricted PDF verification and the request-bound synthetic gold profile are implemented and locally tested. Real institution document formats, certificate authority policy and custody integration are not established.',
    plannedPath:
      'proofs/pdf-evidence/src/{coverage,cms,lib}.rs · proofs/claim-evidence/src/{capsule,request,lib}.rs',
  },
  {
    id: 'prover',
    number: '03',
    title: 'Local claim prover',
    short: 'Bounded private witness → request-bound SP1 output.',
    zone: 'Local Rust process',
    owner: 'SP1 claim guest and explicit local proving runner',
    purpose:
      'Recompute the full EIP-712 request and prove amount ≤ private signed capacity, matching issuer/holder, claim identity and expiry. Keep proving separate from browser receipt checking.',
    input:
      'Bounded local witness, exact request and compiled claim guest. No remote proving or document upload is implicit.',
    output:
      'Exactly 224 public bytes: profile, request digest, signer fingerprint, source ID, claim usage ID, claim commitment and expiry; a cryptographic proof only when explicit proving succeeds.',
    state:
      'PDF and private capacity stay in the local process. Program verification key and ELF hash identify the exact build; changing guest code requires new measurements.',
    guard:
      'Check witness length before allocation. The gate must pin this distinct claim program and verifier; execution output or a signature-only guest is insufficient.',
    failure:
      'Execution/proving failure produces no issuance authorization. A successful execution is labeled as execution, not a generated ZK proof.',
    acceptance:
      'Generate a real proof, verify it against the measured program, reject modified outputs, then validate the exact verifier integration on Hedera with measured resource use.',
    current:
      'A real local CPU core proof and independent verification passed, including request substitution and corrupted-proof rejection. Core proofs are not zero knowledge. Groth16 wrapping and Hedera verifier acceptance remain pending.',
    plannedPath:
      'proofs/claim-guest/src/main.rs · proofs/claim-runner/src/{main,local_proof}.rs',
  },
  {
    id: 'institution',
    number: '04',
    title: 'Issuer reservation & permit',
    short: 'Reserve separately; authorize the exact request.',
    zone: 'Institution boundary',
    owner: 'Authorized issuer; canonical domain library; on-chain reservation',
    purpose:
      'An issuer opens a recipient/token-bound reservation and authorizes a distinct request-bound permit. Fix the reservation reference before the holder signs or the prover executes.',
    input:
      'Institutional holder/reserve records, reservation capacity and expiry, canonical request digest, issuer key version and permit nonce.',
    output:
      'On-chain reservation plus EIP-712 issuer permit. The permit binds request digest, issuer, key version, nonce and expiry under the same chain/gate domain.',
    state:
      'The institution owns physical custody and holder records. The gate stores reservation capacity and cumulative use. Source document capacity stays private and is a different quantity.',
    guard:
      'A holder signature cannot substitute for an issuer permit. Only a live issuer key can authorize; request, reservation, recipient, token and expiry must agree.',
    failure:
      'Missing approval or reservation blocks issuance. Key revocation and expiry are checked on-chain. Observation retries never create a reservation or release its capacity.',
    acceptance:
      'Changed requests invalidate permits; nonce reuse, expired/revoked keys and reservation overflow reject. A valid issuer signature does not prove that gold exists.',
    current:
      'Canonical request/permit helpers and contract authorization are implemented with adversarial tests. No live institution service, issuer provisioning or physical reserve reconciliation is connected.',
    plannedPath:
      'packages/domain/src/{issuance-request,request-digest,issuer-permit}.ts · contracts/src/IssuanceGate.sol',
  },
  {
    id: 'registry',
    number: '05',
    title: 'Versioned trust records',
    short: 'Pin source, issuer, program, policy and rights.',
    zone: 'Hedera EVM',
    owner: 'Immutable governor and append-only records inside IssuanceGate',
    purpose:
      'Define which source signer, issuer key, proof program, policy and token/rights configuration may authorize issuance. Record versions instead of silently replacing their meaning.',
    input:
      'Reviewed identities, key validity windows, verifier/program pins, adapter code hash and rights terms hash.',
    output:
      'Versioned records and irreversible revocation status checked at issuance time.',
    state:
      'The gate stores authority records. Rights terms require separately available documents; a hash does not establish their enforceability.',
    guard:
      'Unset records fail closed. The gate starts paused. Code hashes pin reviewed implementations; upgradeable dependencies require separate trust analysis.',
    failure:
      'Unknown versions, revoked/expired keys, paused gate or changed implementation code reject. Correct proofs do not override live policy.',
    acceptance:
      'Tests reject revoked keys, missing configuration and incompatible versions. Governance can authorize harmful future configurations, so its controller remains an explicit trust boundary.',
    current:
      'Versioned registries, pause and revocation are implemented inside the tested gate. No deployed governance, multisig or timelock is claimed; operational records remain unconfigured.',
    plannedPath: 'contracts/src/IssuanceGate.sol',
  },
  {
    id: 'gate',
    number: '06',
    title: 'Controlled issuance gate',
    short: 'Proof + holder signature + issuer permit + live state.',
    zone: 'Hedera EVM',
    owner: 'IssuanceGate contract',
    purpose:
      'Validate the exact request, both signatures, pinned proof and live authority, then atomically consume replay markers, one claim and reservation capacity before adapter mint.',
    input:
      'Canonical request, holder signature, distinct issuer permit/signature, exact 224-byte public values and nonempty proof bytes.',
    output:
      'One atomic issuance and an Issued event binding the request, claim, reservation, amount, permit digest, public-values hash and program key; otherwise a revert.',
    state:
      'Consumed request IDs/digests, holder and issuer nonces, claim usage IDs and cumulative reservation use are on-chain. Claim single-use is global within this gate, not across deployments.',
    guard:
      'One authenticated claim permits one issuance request, even below private capacity. Unused source capacity cannot be reused in this profile. Reservation consumption remains cumulative and public.',
    failure:
      'Any signature, proof, state or adapter failure reverts all consumption and mint effects. Edge observation never replaces these checks.',
    acceptance:
      'Contract tests cover replay, claim reuse, revocation, expiry, reentrancy, reservation limits, ABI/digest parity and atomic rollback. Real verifier and native HTS acceptance remain separate release gates.',
    current:
      'Solidity gate and local contract tests are implemented. The verifier is represented by a test double in local acceptance tests; no deployed gate or successful real-proof issuance is claimed.',
    plannedPath:
      'contracts/src/{IssuanceGate,RequestHash,SignatureCheck}.sol · contracts/test/{IssuanceGate,SharedClaimAbi}.t.sol',
  },
  {
    id: 'token',
    number: '07',
    title: 'Atomic HTS mint adapter',
    short: 'Create one token; mint and transfer atomically.',
    zone: 'Hedera native HTS',
    owner: 'Gate-only adapter and native HTS system contract',
    purpose:
      'Create a zero-supply token whose sole supply key is the adapter, then accept mint requests only from the immutable gate and transfer the exact minted quantity to the recipient.',
    input:
      'Authorized gate call, recipient and positive milligram amount within the HTS int64 range.',
    output:
      'HTS mint plus transfer in one transaction. One base unit equals one milligram; three decimals display grams.',
    state:
      'HTS owns balances and supply. The adapter is treasury and sole supply-key contract; it exposes no alternate mint, burn, withdrawal or arbitrary-call route.',
    guard:
      'Validate HTS response codes and exact supply, treasury and recipient balance changes. No pre-existing token with undisclosed supply authority is accepted.',
    failure:
      'Native-call failure or an incorrect balance/supply delta reverts the complete issuance. Recipient association and native behavior must be tested on Hedera.',
    acceptance:
      'Local HTS model tests exercise creation, gate-only access, amount limits and rollback. Validate the same behavior against actual native HTS before release.',
    current:
      'Adapter and adversarial local model tests are implemented. This is direct HTS, not ATS. Native deployment, legal instrument fit, regulated transfer controls and redemption operations remain unverified or absent.',
    plannedPath:
      'contracts/src/HederaMintAdapter.sol · contracts/src/interfaces/IHts.sol · contracts/test/HederaMintAdapter.t.sol',
  },
  {
    id: 'audit',
    number: '08',
    title: 'Independent receipt checks',
    short: 'Browser sample worker; separate portable issuance auditor.',
    zone: 'Browser / standalone Node',
    owner: 'Dedicated receipt Web Worker and independent audit library/CLI',
    purpose:
      'Keep sample request consistency separate from issuance evidence. The browser worker checks sample JSON; the portable auditor checks canonical bindings and signatures against a caller-supplied trust policy.',
    input:
      'Browser: bounded sample receipt. CLI/library: distinct issuance receipt with proof bytes, public values, signatures and separately trusted policy.',
    output:
      'Browser: request consistency with evidence/issuer/proof/chain unverified. Auditor: individual checks, missing evidence and an explicitly incomplete overall report.',
    state:
      'Imports remain local. Browser jobs terminate on completion, timeout, cancellation or replacement. The audit library/CLI calls neither the application API nor a chain endpoint.',
    guard:
      'A receipt cannot supply its own trusted policy. Nonempty proof bytes and matching ABI are not proof verification. No proof adapter is loaded by default; strict CLI mode rejects incomplete evidence.',
    failure:
      'Worker failures remain explicit with no main-thread fallback. Missing proof verification or chain history remains unverified, even when request and signature checks succeed.',
    acceptance:
      'Real browser Worker tests cover isolation, bounds, cancellation and timeout. Offline audit tests cover signatures, pins and ABI; independent history, supply and actual proof verification remain required.',
    current:
      'Browser sample checking and portable issuance auditing are implemented and locally tested, with different receipt formats. Neither establishes complete issuance assurance, physical reserves or enforceable redemption.',
    plannedPath:
      'apps/web/src/lib/verification/{receipt.worker,worker-client}.ts · packages/audit/src/{audit,schema,cli}.ts',
  },
];
export const moduleById = Object.fromEntries(
  modules.map((m) => [m.id, m]),
) as Record<ModuleId, BlueprintModule>;
export const registryRecords = [
  [
    'Issuer keys',
    'Versioned issuer authority, expiry and live revocation; separate permit nonce accounting.',
  ],
  [
    'Source signer keys',
    'Versioned source ID and approved SPKI fingerprint; no automatic trust in the document’s own key.',
  ],
  [
    'Programs & policies',
    'Pinned verifier code, program key and profile; policies select the source signer and program.',
  ],
  [
    'Rights & adapters',
    'Versioned token, adapter code hash and terms hash; no claim that a hash creates legal rights.',
  ],
];
export const journey: {
  title: string;
  modules: ModuleId[];
  selected: ModuleId;
  detail: string;
}[] = [
  {
    title: 'Prepare',
    modules: ['client', 'institution'],
    selected: 'institution',
    detail:
      'The institution opens a recipient/token-bound reservation. Fix its reference, amount, claim identity, policy and rights before constructing the canonical request. The browser currently demonstrates this with synthetic data.',
  },
  {
    title: 'Approve',
    modules: ['client', 'institution'],
    selected: 'client',
    detail:
      'The holder approves the complete request. A configured API authenticates the subject and holder signature, then registers the public request in its own SQLite Durable Object. The preview is not wired to this API.',
  },
  {
    title: 'Prove locally',
    modules: ['evidence', 'prover'],
    selected: 'prover',
    detail:
      'The local Rust process authenticates the signed capsule, binds the request and checks amount ≤ private capacity. A core execution proof is verified and kept private. The public ZK wrapper remains pending; no PDF reaches the edge.',
  },
  {
    title: 'Authorize',
    modules: ['institution', 'registry'],
    selected: 'institution',
    detail:
      'The issuer signs a distinct, expiring request-bound permit. This can run alongside proving once all request fields are fixed. Identity-provider authentication and UI approval are not issuer authority.',
  },
  {
    title: 'Issue',
    modules: ['registry', 'gate', 'token'],
    selected: 'gate',
    detail:
      'A wallet or relayer submits to the gate. It checks proof, both signatures and live records, then consumes one claim plus reservation capacity and performs HTS mint/transfer atomically. Any failure reverts.',
  },
  {
    title: 'Observe',
    modules: ['client', 'gate'],
    selected: 'client',
    detail:
      'The client supplies the transaction hash. Durable alarms validate the pinned chain/gate, canonical block and matching Issued event. Leases fence late responses; retries only observe and never submit another mint.',
  },
  {
    title: 'Audit',
    modules: ['audit'],
    selected: 'audit',
    detail:
      'Check an exported issuance receipt against independent trust pins. Report binding/signature checks separately from proof cryptography, chain inclusion, historical authority and supply. Browser sample checking supports a different format.',
  },
];
export const buildPhases = [
  {
    title: '01 / Local module evidence',
    ids: 'Browser · domain · Rust · contracts',
    body: 'Preserve reproducible module tests, shared request/ABI vectors and adversarial cases. Keep sample receipt consistency and SP1 execution labeled by their actual guarantees.',
    exit: 'Implemented and locally tested; no live issuance implied.',
  },
  {
    title: '02 / Cryptographic & chain acceptance',
    ids: 'Claim prover · verifier · gate · HTS',
    body: 'The final guest has a verified local core proof. Generate its Groth16 wrapper, configure reviewed program/source/issuer/rights records and exercise actual Hedera verification, native mint and rollback.',
    exit: 'Pending: ZK wrapper and native deployment acceptance.',
  },
  {
    title: '03 / Operational & independent acceptance',
    ids: 'API Worker · SQLite object · audit',
    body: 'Configure identity, origin, RPC and deployment pins; validate cloud recovery and monitoring. Connect the client and institutional operations, then obtain independent proof, history and supply evidence.',
    exit: 'Pending: configured deployment, institution and full audit evidence.',
  },
];
