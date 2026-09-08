export type CaseId =
  | 'today'
  | 'happy'
  | 'no-reserve'
  | 'mismatch'
  | 'duplicate'
  | 'dishonest'
  | 'bypass'
  | 'delivery';
// Interactive explanations of implementation and trust boundaries, not live results.
export const cases: {
  id: CaseId;
  label: string;
  title: string;
  detail: string;
  verdict: 'open' | 'pass' | 'stop' | 'blind';
}[] = [
  {
    id: 'today',
    label: 'Current implementation',
    title: 'Modules are locally tested; deployment acceptance is pending.',
    detail:
      'The Svelte preview and receipt Web Worker, canonical domain/permit, verified local core proof, Solidity HTS gate, authenticated API/SQLite alarms and portable auditor exist. They are not a connected deployed product. The ZK wrapper, live institution and native Hedera acceptance remain pending.',
    verdict: 'open',
  },
  {
    id: 'happy',
    label: 'All gate conditions satisfied',
    title: 'The gate has one atomic issuance path.',
    detail:
      'Local tests exercise matching signatures, proof outputs, live authority and capacity with test doubles. In a configured deployment, the actual pinned proof verifier and HTS must also succeed. One claim is consumed even when the request uses less than its private capacity.',
    verdict: 'pass',
  },
  {
    id: 'no-reserve',
    label: 'Valid document, no issuer reservation',
    title: 'Document authenticity cannot authorize minting.',
    detail:
      'The gate also requires a live recipient/token-bound reservation and a distinct issuer permit. A login token, holder signature, successful browser check or observed transaction cannot replace either requirement.',
    verdict: 'stop',
  },
  {
    id: 'mismatch',
    label: 'Proof or permit binds a different request',
    title: 'Changed request fields invalidate the combined authorization.',
    detail:
      'The Rust guest, canonical TypeScript and Solidity bind the same EIP-712 request, including chain/gate, amount, recipient, token, claim and versions. Matching standalone signatures are insufficient when their request digests differ.',
    verdict: 'stop',
  },
  {
    id: 'duplicate',
    label: 'Reuse a claim or exceed a reservation',
    title: 'New nonces cannot renew consumed claim authority.',
    detail:
      'The same authenticated source/issuer/claim ID is single-use within the gate, even after a smaller issuance or changed wallet, document export or policy. Separately, a reservation cannot exceed its cumulative capacity. This does not establish uniqueness across deployments or new institutional claim IDs.',
    verdict: 'stop',
  },
  {
    id: 'dishonest',
    label: 'Institution signs a false reserve claim',
    title: 'Cryptographic checks cannot inspect a vault.',
    detail:
      'An accepted signer can attest false capacity or assign multiple claim IDs to the same asset. The private-capacity predicate and single-use gate do not turn snapshots into exclusive reserves. Custody records and independent institutional accountability remain necessary.',
    verdict: 'blind',
  },
  {
    id: 'bypass',
    label: 'Governance approves a harmful configuration',
    title: 'The governor remains a trust boundary.',
    detail:
      'The implemented adapter creates its own token with a sole supply key and exposes only gate-authorized minting. That closes an alternate adapter mint route, but governance can still admit a dishonest issuer, source or verifier. Code hashes do not establish honest policy or safe proxy state.',
    verdict: 'blind',
  },
  {
    id: 'delivery',
    label: 'Successful mint mistaken for redemption rights',
    title: 'Token issuance does not establish gold delivery.',
    detail:
      'The implemented HTS adapter handles creation, mint and transfer. ATS controls, redemption/burn operations, legal instrument fit and physical delivery are not implemented or established. Neither a confirmed tracking status nor a consistent audit receipt fills those gaps.',
    verdict: 'blind',
  },
];
