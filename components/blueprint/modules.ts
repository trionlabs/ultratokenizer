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
// Target architecture, not a registry of implemented services.
export const modules: BlueprintModule[] = [
  {
    id: 'client',
    number: '01',
    title: 'Request & wallet',
    short: 'Choose the right, amount and disclosure.',
    zone: 'User',
    owner: 'User-controlled client',
    purpose:
      'Show the supported rights template, amount, recipient and disclosure preview. Ask the user to approve one canonical issuance request.',
    input:
      'Document selection, rights/policy version, amount and recipient wallet.',
    output: 'Canonical issuance request and wallet approval.',
    state:
      'The user controls the original document. A draft may be stored locally. Wallet keys never go to the application server.',
    guard:
      'Recipient, chain, token and amount must match the approval screen. A wallet signature alone does not establish document ownership.',
    failure:
      'Unsupported document or wrong chain stops progress. Changing the amount requires fresh approval.',
    acceptance:
      'Changing recipient or amount invalidates the previous approval. Public fields are visible before signing.',
    current:
      'Request responsibilities are documented only. No file upload or wallet connection is implemented.',
    plannedPath: 'packages/client',
  },
  {
    id: 'evidence',
    number: '02',
    title: 'Evidence adapter',
    short: 'Signed source → defined document claim.',
    zone: 'Private data',
    owner: 'Versioned document schema',
    purpose:
      'Support one signed PDF format first. Signature coverage, field meaning, amount and units must also be enforced inside the proof program.',
    input: 'Private PDF, accepted source key and pinned schema.',
    output: 'Private witness and the precise claim to prove.',
    state:
      'Raw PDF/EML stays off-chain. A plain document hash does not automatically anonymize personal information.',
    guard:
      'Reject unsigned revisions, ambiguous fields and unit confusion. Frontend parsing alone is not proof enforcement.',
    failure:
      'Invalid signatures or unsupported schemas stop proof generation. Never silently switch to another template.',
    acceptance:
      'An amount added after signing and conflicting duplicate fields are rejected.',
    current:
      'Document requirements are documented only. No cryptographic adapter is connected.',
    plannedPath: 'packages/evidence',
  },
  {
    id: 'prover',
    number: '03',
    title: 'ZK prover',
    short: 'Private witness → proof + public outputs.',
    zone: 'User control',
    owner: 'Separate proving process',
    purpose:
      'Prove the selected condition in an accepted signed document without revealing the full document to the verifier. Bind the proof to the issuance request.',
    input:
      'Private witness, canonical request and pinned circuit/program version.',
    output: 'Proof, public inputs, program identity and request commitment.',
    state:
      'Prefer a user-controlled prover. If a remote provider sees the witness, disclose that explicitly. Local parsing is not local proving.',
    guard:
      'The circuit constrains the request commitment. A user cannot choose an arbitrary verifier.',
    failure:
      'A timeout or cancellation never starts issuance. Proof generation can retry for the same request.',
    acceptance:
      'A real proof verifies on Hedera testnet; modified public inputs fail. Measure proving time and verification cost.',
    current:
      'No proof generation or verifier calls. The interface shows design examples.',
    plannedPath: 'packages/prover',
  },
  {
    id: 'institution',
    number: '04',
    title: 'Institution bridge',
    short: 'Verify holder → reserve → authorize.',
    zone: 'Institution',
    owner: 'Custodian / authorized issuer',
    purpose:
      'Match the rights holder to the recipient using institutional records, reserve capacity and sign a time-limited permit for the same request.',
    input: 'Request commitment and the institution’s holder/reserve records.',
    output: 'Reservation ID, capacity and a signed, expiring permit.',
    state:
      'Physical reserve records belong to the institution. On-chain allocation and consumption are correlated with requestId.',
    guard:
      'Only an authorized institution key may approve. A retry cannot create another reservation; permit renewal cannot reset capacity.',
    failure:
      'An unavailable institution means approval pending. Keep the reserve locked while a chain result is uncertain; reconcile before release.',
    acceptance:
      'Retries produce one reservation. Revoked permits block minting. A valid signature does not establish the truth of a physical reserve claim.',
    current:
      'Institution approval is an illustrative scenario. No custodian API is connected.',
    plannedPath: 'services/institution-bridge',
  },
  {
    id: 'registry',
    number: '05',
    title: 'Registries & governance',
    short: 'Who is trusted, for what, under which rules?',
    zone: 'Hedera EVM',
    owner: 'Restricted governance roles',
    purpose:
      'Version issuer authority, source keys, accepted proof policies and represented rights. Four logical registries can start in one contract.',
    input: 'Reviewed issuer, key, policy and rights definitions.',
    output:
      'Active records at issuance, historical versions and revocation status.',
    state:
      'On-chain records govern authorization. Accessible copies of accepted rights terms are archived separately.',
    guard:
      'Track role grants, upgrades and key revocations. Propose multiple approvals and an on-chain delay for ordinary authority expansion.',
    failure:
      'Unknown versions or revoked keys block new issuance. Historical records must not be silently overwritten.',
    acceptance:
      'Reconstruct the rules used for an old issuance. An emergency pause role cannot grant itself mint authority.',
    current: 'Registry contracts and governance are not implemented.',
    plannedPath: 'contracts/PolicyRegistry.sol',
  },
  {
    id: 'gate',
    number: '06',
    title: 'Issuance gate',
    short: 'Proof + permit + live state.',
    zone: 'Hedera EVM',
    owner: 'IssuanceGate contract',
    purpose:
      'Join document evidence with institutional authorization. Check recipient, amount, chain, token, policy, expiry, eligibility and capacity at mint time.',
    input: 'Proof, public inputs, permit and current registry/capacity state.',
    output:
      'Atomic capacity/nonce consumption and authorized ATS mint, or rejection.',
    state:
      'ReservationLedger, consumed permit nonces and usage keyed to a stable authenticated claim identity live on-chain.',
    guard:
      'Consumption and ATS mint share one EVM transaction. Canonical units are required. A new wallet or permit cannot renew an exhausted claim.',
    failure:
      'A failed check or ATS call reverts the whole chain transaction. Query an uncertain submission by transaction/request ID before retrying.',
    acceptance:
      'Reject wrong recipient/amount, revocation, replay and concurrent capacity overflow. Test reentrancy and alternative issuer paths.',
    current:
      'Capacity and replay rules are illustrative scenarios. No issuance reducer or contract is implemented.',
    plannedPath: 'contracts/IssuanceGate.sol',
  },
  {
    id: 'token',
    number: '07',
    title: 'Token lifecycle',
    short: 'Issue → transfer → redeem.',
    zone: 'ATS + institution',
    owner: 'Token contract and redemption operations',
    purpose:
      'Manage a token representing the chosen right through ATS. Support eligible transfers and redemption by the current holder.',
    input:
      'Authorized mint, transfer or redemption request and current eligibility.',
    output: 'Balances, transfers, holds/burns and a separate delivery status.',
    state:
      'Balances and holds are on-chain. Physical delivery belongs to the institution. Burning never creates delivery confirmation automatically.',
    guard:
      'Use ATS eligibility and roles. Include direct issuer/upgrade paths in the audit. Burning does not reopen issuance capacity.',
    failure:
      'Cancellation before burn unlocks tokens. After burn, failed delivery remains an open delivery/remediation claim.',
    acceptance:
      'The current holder can redeem; the previous holder cannot. Example: 100 issued − 30 burned = 70 supply; delivery of 30 is tracked separately.',
    current:
      'ATS integration, instrument fit and partial redemption are not implemented or verified.',
    plannedPath: 'packages/token-lifecycle',
  },
  {
    id: 'audit',
    number: '08',
    title: 'Independent auditor',
    short: 'Export the evidence. Verify elsewhere.',
    zone: 'Independent client',
    owner: 'Open verifier and evidence packager',
    purpose:
      'Recheck the proof, issuance-time authority, all supply changes and governance interventions without requesting the private document.',
    input: 'Proof package, permit, version manifest and chain history.',
    output:
      'Separate results for proof validity, authority, supply reconciliation, data completeness and current revocation alerts.',
    state:
      'Downloadable packages and archived version manifests. Mirror Node is a retrieval source; one API response is not a consensus proof.',
    guard:
      'Missing evidence cannot produce success. Minting through another issuer path must appear in total-supply reconciliation.',
    failure:
      'Report incomplete data and try another evidence source. The application API going offline must not prevent independent verification.',
    acceptance:
      'Verify an exported package with the Ultratokenizer API offline. Distinguish a bad proof from missing history.',
    current: 'No independent verifier or real audit package is implemented.',
    plannedPath: 'packages/auditor',
  },
];
export const moduleById = Object.fromEntries(
  modules.map((m) => [m.id, m]),
) as Record<ModuleId, BlueprintModule>;
export const registryRecords = [
  [
    'IssuerRegistry',
    'Issuer scope, token permissions, permit key and active authority.',
  ],
  [
    'SourceKeyRegistry',
    'PDF/DKIM source keys, validity periods and revocations.',
  ],
  [
    'PolicyRegistry',
    'Accepted verifier, circuit/program, schema and public-input versions.',
  ],
  [
    'RightsRegistry',
    'Represented right, parties, accepted terms version and redemption conditions.',
  ],
];
export const journey: {
  title: string;
  modules: ModuleId[];
  selected: ModuleId;
  detail: string;
}[] = [
  {
    title: 'Request',
    modules: ['client', 'evidence'],
    selected: 'client',
    detail:
      'Approve the right, amount, recipient and disclosed information. Create one canonical request.',
  },
  {
    title: 'Prove',
    modules: ['evidence', 'prover'],
    selected: 'prover',
    detail:
      'Prove the condition in the private document. Bind proof outputs to the same request.',
  },
  {
    title: 'Authorize',
    modules: ['institution'],
    selected: 'institution',
    detail:
      'The institution matches the holder, reserves capacity and signs an expiring permit. It may run in parallel with proving only after all shared request fields, including the reservation reference, are fixed.',
  },
  {
    title: 'Check',
    modules: ['registry', 'gate'],
    selected: 'gate',
    detail:
      'Check proof, permit, live keys/policy, eligibility, replay protection and remaining capacity on-chain.',
  },
  {
    title: 'Issue',
    modules: ['gate', 'token'],
    selected: 'token',
    detail:
      'Consume capacity and nonce in the same chain transaction as ATS mint. A failure reverts the complete transaction.',
  },
  {
    title: 'Audit',
    modules: ['audit'],
    selected: 'audit',
    detail:
      'Export the proof package. Independently verify it without the private document or application API.',
  },
  {
    title: 'Redeem',
    modules: ['token', 'audit'],
    selected: 'token',
    detail:
      'The current holder requests redemption. Track hold, cancellation, burn and delivery separately. Burning does not renew reserve capacity.',
  },
];
export const buildPhases = [
  {
    title: '01 / Real evidence',
    ids: '01 · 02 · 03',
    body: 'One signed PDF schema and canonical request. Real Hedera verification with proving time and gas measurements.',
    exit: 'Modified public inputs are rejected.',
  },
  {
    title: '02 / Controlled issuance',
    ids: '04 · 05 · 06 · 07',
    body: 'One institution, versioned initial policy, reservations and ATS lifecycle. Exercise negative and concurrent cases.',
    exit: 'The same capacity cannot be consumed twice.',
  },
  {
    title: '03 / Independent audit',
    ids: '08 + all modules',
    body: 'Define the package schema from day one. Connect the external verifier and full history reconciliation end to end.',
    exit: 'Verification works with the application API offline.',
  },
];
