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
      'The wallet UI, receipt worker, exact-quantity guest, Gate, institution ledger and outcome bridge, issuer wallet client and observer have local checks. ATS has real local Gate integration and an HFS creation transport. Verified Groth16, whole-graph deployment and live acceptance remain open.',
    verdict: 'open',
  },
  {
    id: 'happy',
    label: 'All gate conditions satisfied',
    title: 'The gate has one atomic issuance path.',
    detail:
      'Local tests exercise matching signatures, proof outputs, live authority and exact reservations with test doubles. In a configured deployment, the actual pinned verifier and token backend must also succeed. One claim is consumed only for its full exact authenticated quantity.',
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
      'The same authenticated source/stable-claim identity is single-use within the gate, despite changed issuer, wallet, token or policy. Each reservation binds one exact request; pending plus outstanding quantities obey an aggregate cap. New deployments or newly assigned institutional claim IDs still require continuity controls.',
    verdict: 'stop',
  },
  {
    id: 'dishonest',
    label: 'Institution signs a false reserve claim',
    title: 'Cryptographic checks cannot inspect a vault.',
    detail:
      'An accepted signer can attest a false quantity or assign multiple claim IDs to the same asset. Exact-quantity proof and single-use state do not turn snapshots into exclusive reserves. Custody records and independent institutional accountability remain necessary.',
    verdict: 'blind',
  },
  {
    id: 'bypass',
    label: 'Governance approves a harmful configuration',
    title: 'The governor remains a trust boundary.',
    detail:
      'Native HTS creates a sole-supply-key token. The ATS adapter requires separately admitted roles and a resolver/facet graph. Both restrict adapter mint calls to the Gate, but governance can admit a dishonest source, program or adapter. Code hashes do not establish honest policy or safe proxy state.',
    verdict: 'blind',
  },
  {
    id: 'delivery',
    label: 'Successful mint mistaken for redemption rights',
    title: 'Token issuance does not establish gold delivery.',
    detail:
      'Token adapters support mint and divisible transfers. The narrow ATS profile excludes administrative maintenance and recovery. Redemption/burn settlement, legal instrument fit and physical delivery are not implemented or established. Neither a confirmed tracking status nor a consistent audit receipt fills those gaps.',
    verdict: 'blind',
  },
];
