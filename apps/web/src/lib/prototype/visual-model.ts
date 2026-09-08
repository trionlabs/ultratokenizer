import type { Journey, Role, Stage, Event } from '../domain/journey';

export type Variant = 'A' | 'B' | 'C';
export type InspectorTab =
  'request' | 'privacy' | 'audit' | 'scenarios' | 'discoveries';
export type FlowProps = {
  journey: Journey;
  role: Role;
  onaction: (event: Event) => void;
  onrole: (role: Role) => void;
  oninspect: (tab: InspectorTab) => void;
};

export const variants: ReadonlyArray<{ id: Variant; name: string }> = [
  { id: 'A', name: 'Orbit' },
  { id: 'B', name: 'Workbench' },
  { id: 'C', name: 'Passport' },
];

export const stageCopy: Record<
  Stage,
  { title: string; hint: string; label: string }
> = {
  document: {
    title: 'Your gold. A new form.',
    hint: 'Start with a signed document.',
    label: 'Document',
  },
  review: {
    title: 'How much goes on-chain?',
    hint: 'Choose your sample amount.',
    label: 'Amount',
  },
  authorization: {
    title: 'Three checks. One approval.',
    hint: 'A document needs an issuer.',
    label: 'Approval',
  },
  proof: {
    title: 'Keep the source. Prove the claim.',
    hint: 'One proof, bound to your request.',
    label: 'Proof',
  },
  mint: {
    title: 'Ready for its next form.',
    hint: 'Review once. Confirm once.',
    label: 'Mint',
  },
  receipt: {
    title: 'A claim you can inspect.',
    hint: 'Sample complete. No token was minted.',
    label: 'Receipt',
  },
};

export const sequence: Stage[] = [
  'document',
  'review',
  'authorization',
  'proof',
  'mint',
  'receipt',
];

export function readVariant(value: string | null): Variant {
  return value === 'B' || value === 'C' ? value : 'A';
}
