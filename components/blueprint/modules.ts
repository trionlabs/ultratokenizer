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
// Status describes the working implementation, never a deployment attestation.
export const modules: BlueprintModule[] = [
  {
    id: 'client',
    number: '01',
    title: 'Request & coordination',
    short: 'Wallet issuance; separate authenticated observation.',
    zone: 'Browser / edge',
    owner: 'Browser session; API Worker; one SQLite Durable Object per request',
    purpose:
      'Keep presentation separate from authenticated request tracking. The API validates ownership; a per-request object persists lifecycle transitions and alarms that reconcile a wallet-supplied transaction hash.',
    input:
      'Browser: proof/permit bundle, independent deployment pins and an actual wallet. API: short-lived access token, canonical request and holder EIP-712 signature; later, a transaction hash.',
    output:
      'Fixed-amount wallet signing, submission and canonical receipt reconciliation; separately, subject-owned observation state and bounded history. Observation requires a matching gate event through configured RPC.',
    state:
      'The Svelte session is in memory. SQLite stores public request fields, an ownership digest and observation state. Private PDFs, witnesses, access tokens and holder signatures are not persisted at the edge.',
    guard:
      'The API requires configured identity keys, exact origin, holder ownership and bounded input. Alarms persist a recovery lease before RPC and fence late responses. No API route signs, submits or retries a mint.',
    failure:
      'RPC uncertainty preserves the request. Exhausted observation retries require authenticated reconciliation. Stopping tracking does not revoke a signature or release a reservation.',
    acceptance:
      'Concurrent registration is idempotent; another subject is denied; SQL/alarm rollback and process restart preserve recovery. A matching event establishes observation, not independent proof or issuer authority.',
    current:
      'The actual wallet issuance/transfer client, Svelte session and authenticated Worker/SQLite observer have local tests. The observer is a separate integration with unset deployment configuration; no live issuance is claimed.',
    plannedPath:
      'apps/web/src/lib/application/issuance-session.ts · packages/issuance/src/client.ts · workers/issuance/src/{index,auth,coordinator,chain-observer}.ts',
  },
  {
    id: 'evidence',
    number: '02',
    title: 'Signed claim evidence',
    short: 'Strict signed bytes → one authenticated gold claim.',
    zone: 'Private local input',
    owner: 'Rust PDF verifier and versioned synthetic claim profile',
    purpose:
      'Authenticate a restricted RSA-SHA256 signed PDF and its fixed gold capsule. Derive an issuer-independent source/stable-claim use identity and bind the holder, commitment and exact amount to the canonical request.',
    input:
      'Local PDF, approved signer fingerprint and canonical request. The capsule contains private capacity, holder, issuer, source, claim ID, unit and expiry.',
    output:
      'Validated private witness and seven public claim words. Issuance uses the full authenticated quantity, which becomes public with the wallet from reservation broadcast; other document fields remain private.',
    state:
      'The document remains in the local Rust process. Neither the wallet UI nor the edge API accepts personal PDFs. Source claim IDs must be stable and suitably unpredictable.',
    guard:
      'Reject unsigned revisions, ambiguous signature gaps, unsupported CMS shapes, duplicate capsule markers, wrong holder/issuer, unit mismatch and any amount unequal to the authenticated quantity.',
    failure:
      'Unsupported or malformed evidence stops execution. The signature-only 96-byte profile cannot satisfy the distinct 224-byte issuance claim profile.',
    acceptance:
      'Native and SP1 guest rejection tests cover mutations; Rust request parsing agrees with canonical TypeScript vectors. Signed-byte authentication does not establish PDF rendering semantics or physical backing.',
    current:
      'The synthetic claim profile is locally tested. A separate native CAdES/Enpara extractor reads available XAU from reviewed authenticated revisions; its guest, font/revision admission policy and institutional allocation binding remain open.',
    plannedPath:
      'proofs/pdf-evidence/src/{coverage,cms,lib}.rs · proofs/claim-evidence/src/{capsule,request,lib}.rs · proofs/enpara-evidence/src/lib.rs',
  },
  {
    id: 'prover',
    number: '03',
    title: 'Local claim prover',
    short: 'Bounded private witness → request-bound SP1 output.',
    zone: 'Local Rust process',
    owner: 'SP1 claim guest and explicit local proving runner',
    purpose:
      'Recompute the full EIP-712 request and prove amount equals the authenticated quantity, with matching issuer/holder, claim identity and expiry. Keep proving separate from browser receipt checking.',
    input:
      'Bounded local witness, exact request and compiled claim guest. No remote proving or document upload is implicit.',
    output:
      'Exactly 224 public bytes: profile, request digest, signer fingerprint, source ID, claim usage ID, claim commitment and expiry; a cryptographic proof only when explicit proving succeeds.',
    state:
      'PDF and witness stay in the local process; the exact quantity is public from reservation. Program verification key and ELF hash identify the build; changing guest code requires new measurements.',
    guard:
      'Check witness length before allocation. The gate must pin this distinct claim program and verifier; execution output or a signature-only guest is insufficient.',
    failure:
      'Execution/proving failure produces no issuance authorization. A successful execution is labeled as execution, not a generated ZK proof.',
    acceptance:
      'Generate a real proof, verify it against the measured program, reject modified outputs, then validate the exact verifier integration on Hedera with measured resource use.',
    current:
      'Current exact-quantity guest execution and rejection tests pass. A historical earlier program had a verified CPU core proof, which is not zero knowledge. The current pinned program still needs genuine Groth16 and positive Hedera verifier acceptance.',
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
      'Fix the exact allocation and reservation reference before constructing the request. The issuer wallet client checks its proof, opens and confirms the matching reservation, then signs a distinct expiring permit.',
    input:
      'Institutional holder/reserve records, reservation capacity and expiry, canonical request digest, issuer key version and permit nonce.',
    output:
      'On-chain reservation plus EIP-712 issuer permit. The permit binds request digest, issuer, key version, nonce and expiry under the same chain/gate domain.',
    state:
      'A private SQLite ledger persists stable rights and pending/outstanding allocations. The gate stores exact reservations and aggregate caps. The whole source quantity becomes public at reservation; software records do not establish physical custody.',
    guard:
      'A holder signature cannot substitute for an issuer permit. Only a live issuer key can authorize; request, reservation, recipient, token and expiry must agree.',
    failure:
      'Missing approval or reservation blocks issuance. Key revocation and expiry are checked on-chain. Observation retries never create a reservation or release its capacity.',
    acceptance:
      'Changed requests invalidate permits; nonce reuse, expired/revoked keys and reservation overflow reject. A valid issuer signature does not prove that gold exists.',
    current:
      'A durable institution ledger and actual wallet proof/reservation/permit client are implemented and locally tested. Their trusted lifecycle bridge, deployed signer and physical reserve reconciliation remain unconnected.',
    plannedPath:
      'packages/institution/src/ledger.ts · packages/issuance/src/issuer.ts · packages/domain/src/issuer-permit.ts · contracts/src/IssuanceGate.sol',
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
      'Consumed request IDs/digests, holder and issuer nonces, claim usage IDs, reservation state and aggregate backing totals are on-chain. Claim single-use is global within this gate, not across deployments.',
    guard:
      'One authenticated claim permits one issuance of its full exact quantity. Smaller and larger requests reject. Pending reservations plus outstanding issuance cannot exceed the configured issuer/token backing cap.',
    failure:
      'Any signature, proof, state or adapter failure reverts all consumption and mint effects. Edge observation never replaces these checks.',
    acceptance:
      'Contract tests cover replay, claim reuse, revocation, expiry, reentrancy, reservation limits, ABI/digest parity and atomic rollback. Real verifier and native HTS acceptance remain separate release gates.',
    current:
      'Gate state tests use explicit test verifiers. Production deployment requires the pinned direct SP1 verifier, whose malformed-proof rejection is tested. No deployed gate or positive real-proof issuance is claimed.',
    plannedPath:
      'contracts/src/{IssuanceGate,RequestHash,SignatureCheck}.sol · contracts/test/{IssuanceGate,SharedClaimAbi}.t.sol',
  },
  {
    id: 'token',
    number: '07',
    title: 'Atomic token mint adapters',
    short: 'Issue the full quantity through the selected token backend.',
    zone: 'Hedera HTS or admitted ATS contracts',
    owner: 'Gate-only adapter and independently reviewed token configuration',
    purpose:
      'Accept mint only from the immutable Gate. Native HTS creates its own sole-supply-key token; ATS binds an independently admitted empty token and runtime graph.',
    input:
      'Authorized Gate call, recipient and positive integer milligrams within the signed 64-bit range.',
    output:
      'Exact supply and recipient increases in the same transaction. Three decimals display grams; later transfers remain divisible into milligrams.',
    state:
      'HTS owns native balances. ATS stores balances behind a selected resolver/facet configuration; its issuance, admin and configuration state require separate admission.',
    guard:
      'Check exact mint deltas and immutable Gate access. ATS also checks enrolled runtime continuity; supplied code hashes alone cannot certify graph or role safety.',
    failure:
      'A token-call failure or incorrect delta reverts the complete issuance. Native HTS association does not apply to ATS tokens.',
    acceptance:
      'Main tests inject authorization, code and delta failures. A separate real ATS/Gate local run uses a test verifier; genuine proof and Hedera consensus execution remain required.',
    current:
      'Both adapters and backend-aware wallet dispatch are implemented. The deployment script still provisions HTS only; complete ATS provisioning and live acceptance remain open. No redemption or physical delivery is established.',
    plannedPath:
      'contracts/src/{HederaMintAdapter,AtsGateMintAdapter}.sol · packages/issuance/src/{ats,chain,client}.ts · contracts/test/AtsGateMintAdapter.t.sol',
  },
  {
    id: 'audit',
    number: '08',
    title: 'Independent receipt checks',
    short: 'One issuance receipt format; independent trust pins.',
    zone: 'Browser / standalone Node',
    owner: 'Dedicated receipt Web Worker and independent audit library/CLI',
    purpose:
      'Check canonical issuance bindings and signatures against independently supplied trust pins in the browser worker or portable auditor. Report each evidence boundary separately.',
    input:
      'Bounded issuance receipt with proof bytes, public values and signatures, plus a separately trusted policy. Historical sample receipts are rejected.',
    output:
      'Individual binding/signature checks, missing evidence and an explicitly incomplete overall report. Optional RPC proof verification does not establish historical authority or chain inclusion.',
    state:
      'Imports remain local. Browser jobs terminate on completion, timeout, cancellation or replacement. Auditing is offline by default; an explicitly configured RPC adapter can check proof cryptography.',
    guard:
      'A receipt cannot supply its own trusted policy. Nonempty proof bytes and matching ABI are not proof verification. No proof adapter is loaded by default; strict CLI mode rejects incomplete evidence.',
    failure:
      'Worker failures remain explicit with no main-thread fallback. Missing proof verification or chain history remains unverified, even when request and signature checks succeed.',
    acceptance:
      'Real browser Worker tests cover isolation, bounds, cancellation and timeout. Offline audit tests cover signatures, pins and ABI; independent history, supply and actual proof verification remain required.',
    current:
      'Browser and portable issuance auditing use the same receipt format and are locally tested. Neither establishes complete issuance assurance, physical reserves or enforceable redemption.',
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
      'Allocate a stable right and fix its exact quantity, reservation reference, holder, policy and rights before constructing the canonical request. The durable ledger exists; its trusted chain/wallet bridge remains open.',
  },
  {
    title: 'Approve',
    modules: ['client', 'institution'],
    selected: 'client',
    detail:
      'The holder wallet signs the complete fixed-amount request. A separately configured observation API can authenticate the holder and track the public request in a SQLite Durable Object; it cannot authorize issuance.',
  },
  {
    title: 'Prove locally',
    modules: ['evidence', 'prover'],
    selected: 'prover',
    detail:
      'The local Rust process authenticates the signed capsule, binds the request and requires its full exact quantity. Current guest execution is tested; genuine Groth16 for the pinned program remains pending. No PDF reaches the edge.',
  },
  {
    title: 'Authorize',
    modules: ['institution', 'registry'],
    selected: 'institution',
    detail:
      'The issuer wallet client checks the proof and live records, opens and confirms the exact reservation, then signs a short-lived request-bound permit. Login and UI approval cannot replace this authority.',
  },
  {
    title: 'Issue',
    modules: ['registry', 'gate', 'token'],
    selected: 'gate',
    detail:
      'A wallet or relayer submits to the gate. It checks proof, both signatures and live records, then consumes one claim plus reservation capacity and issues through the admitted HTS or ATS adapter atomically. Any failure reverts.',
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
      'Check an exported issuance receipt against independent trust pins in the browser or portable auditor. Report binding/signature checks separately from proof cryptography, chain inclusion, historical authority and supply.',
  },
];
export const buildPhases = [
  {
    title: '01 / Local module evidence',
    ids: 'Browser · domain · Rust · contracts',
    body: 'Preserve reproducible module tests, shared request/ABI vectors and adversarial cases. Distinguish wallet transport fixtures, receipt binding checks and SP1 execution from real proof or chain acceptance.',
    exit: 'Implemented and locally tested; no live issuance implied.',
  },
  {
    title: '02 / Cryptographic & chain acceptance',
    ids: 'Claim prover · verifier · gate · HTS',
    body: 'Generate genuine Groth16 for the current pinned guest, configure reviewed trust records and exercise actual Hedera verification, mint and rollback. An isolated real-contract ATS spike evaluates the prize-required backend; native HTS remains the implemented baseline.',
    exit: 'Pending: ZK wrapper and native deployment acceptance.',
  },
  {
    title: '03 / Operational & independent acceptance',
    ids: 'API Worker · SQLite object · audit',
    body: 'Configure identity, origin, RPC and deployment pins; validate cloud recovery and monitoring. Connect the client and institutional operations, then obtain independent proof, history and supply evidence.',
    exit: 'Pending: configured deployment, institution and full audit evidence.',
  },
];
