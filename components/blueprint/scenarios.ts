export type CaseId =
  | 'today'
  | 'happy'
  | 'no-reserve'
  | 'mismatch'
  | 'duplicate'
  | 'dishonest'
  | 'bypass'
  | 'delivery';
// Illustrative outcomes, not results from a proof engine or a deployed contract.
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
    title: 'Real integrations are pending.',
    detail:
      'This is an interactive architecture blueprint. The prover, institution bridge, registries, ATS integration and independent auditor are proposed modules.',
    verdict: 'open',
  },
  {
    id: 'happy',
    label: 'All conditions satisfied',
    title: 'The proposed gate allows issuance.',
    detail:
      'Assume the real proof, bound permit, live authority, eligibility and sufficient capacity all pass. This example does not establish physical reserve truth.',
    verdict: 'pass',
  },
  {
    id: 'no-reserve',
    label: 'Valid document, no reservation',
    title: 'A valid document cannot authorize issuance alone.',
    detail:
      'The institution has not allocated usable capacity. Approval remains pending; the issuance gate cannot mint.',
    verdict: 'stop',
  },
  {
    id: 'mismatch',
    label: 'Valid evidence, different request',
    title: 'Two valid records are not enough.',
    detail:
      'The proof and permit refer to different requests. The gate must compare the bound amount, recipient, token, chain and claim commitment.',
    verdict: 'stop',
  },
  {
    id: 'duplicate',
    label: 'Reuse an exhausted reservation',
    title: 'A new document cannot renew capacity.',
    detail:
      'The example reservation has already been consumed. A new PDF, permit nonce or wallet must not create additional capacity.',
    verdict: 'stop',
  },
  {
    id: 'dishonest',
    label: 'Institution lies about reserves',
    title: 'Checks may pass while physical gold is missing.',
    detail:
      'An authorized institution can sign a false reserve statement. Cryptographic verification cannot inspect a vault; reserve accountability remains outside the proof.',
    verdict: 'blind',
  },
  {
    id: 'bypass',
    label: 'Admin bypasses the proof gate',
    title: 'An alternative issuer can defeat the gate.',
    detail:
      'If a role grant or upgrade permits another mint path, a correct proof gate is insufficient. Constrain those powers and reconcile every supply change in the auditor.',
    verdict: 'blind',
  },
  {
    id: 'delivery',
    label: 'Tokens burned, delivery missing',
    title: 'Burning does not complete delivery.',
    detail:
      'After a burn, missing delivery remains an open institutional obligation. Never mark it delivered or automatically reopen issuance capacity.',
    verdict: 'blind',
  },
];
