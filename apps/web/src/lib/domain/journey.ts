/** Presentation state only. These transitions confer no cryptographic authority. */
export type Stage =
  'document' | 'review' | 'authorization' | 'proof' | 'mint' | 'receipt';
export type Role = 'holder' | 'issuer' | 'audit';
export type EvidenceScenario = 'supported' | 'tampered' | 'unsupported';
export type IssuerCheck = 'subject' | 'reservation' | 'rights';
export type Failure =
  | 'tampered'
  | 'unsupported'
  | 'issuer_rejected'
  | 'proof_rejected'
  | 'wallet_rejected';

export type Journey = Readonly<{
  mode: 'simulation';
  stage: Stage;
  amountMg: string;
  reviewed: boolean;
  issuerChecks: Readonly<Record<IssuerCheck, boolean>>;
  authorization: 'missing' | 'simulated';
  proof: 'missing' | 'simulated';
  receipt: 'missing' | 'simulated';
  failure: Failure | null;
}>;

export type Event =
  | { type: 'reset' }
  | { type: 'load_sample'; scenario: EvidenceScenario }
  | { type: 'review'; grams: string; consent: boolean }
  | { type: 'edit_request' }
  | { type: 'issuer_check'; check: IssuerCheck; checked: boolean }
  | { type: 'authorize' }
  | { type: 'reject_authorization' }
  | { type: 'prove'; succeeds: boolean }
  | { type: 'mint'; succeeds: boolean };

export const stages: ReadonlyArray<{
  id: Stage;
  title: string;
  detail: string;
}> = [
  { id: 'document', title: 'Document', detail: 'Select & authenticate' },
  { id: 'review', title: 'Review', detail: 'Amount & disclosure' },
  { id: 'authorization', title: 'Approval', detail: 'Issuer & reservation' },
  { id: 'proof', title: 'Proof', detail: 'Bind the request' },
  { id: 'mint', title: 'Mint', detail: 'Confirm in wallet' },
  { id: 'receipt', title: 'Receipt', detail: 'Inspect the result' },
];

export const failures: Record<Failure, { title: string; recovery: string }> = {
  tampered: {
    title: 'Document integrity failed',
    recovery:
      'Use the original signed document. An edited statement cannot continue.',
  },
  unsupported: {
    title: 'Document format is not supported',
    recovery:
      'Use a supported signed revision. Do not remove signatures or convert the PDF to an image.',
  },
  issuer_rejected: {
    title: 'Issuer declined the request',
    recovery:
      'Resolve the holder or reservation issue with the issuer before requesting approval again.',
  },
  proof_rejected: {
    title: 'Proof verification failed',
    recovery:
      'No mint was submitted. Retry proving; keep the approved request unchanged.',
  },
  wallet_rejected: {
    title: 'Wallet confirmation declined',
    recovery: 'No mint was submitted. You can retry this request.',
  },
};

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowError';
  }
}

function freeze(state: Journey): Journey {
  return Object.freeze({
    ...state,
    issuerChecks: Object.freeze({ ...state.issuerChecks }),
  });
}

export function createJourney(): Journey {
  return freeze({
    mode: 'simulation',
    stage: 'document',
    amountMg: '1000',
    reviewed: false,
    issuerChecks: { subject: false, reservation: false, rights: false },
    authorization: 'missing',
    proof: 'missing',
    receipt: 'missing',
    failure: null,
  });
}

/** The sample has 10 g. Accept exact milligrams, never floating-point arithmetic. */
export function parseSampleAmount(grams: string): string {
  if (
    typeof grams !== 'string' ||
    grams.length > 12 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(grams)
  ) {
    throw new FlowError(
      'Enter grams with up to three decimal places, such as 1.250.',
    );
  }
  const [whole, fraction = ''] = grams.split('.');
  const amount = BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, '0'));
  if (amount <= BigInt(0) || amount > BigInt(10000)) {
    throw new FlowError(
      'Choose an amount greater than zero and no more than the 10.000 g sample balance.',
    );
  }
  return amount.toString();
}

export function formatGrams(milligrams: string): string {
  const value = BigInt(milligrams);
  return `${value / BigInt(1000)}.${(value % BigInt(1000)).toString().padStart(3, '0')}`;
}

export function canAuthorize(state: Journey): boolean {
  return (
    state.stage === 'authorization' &&
    state.reviewed &&
    state.failure !== 'issuer_rejected' &&
    state.issuerChecks.subject &&
    state.issuerChecks.reservation &&
    state.issuerChecks.rights
  );
}

export function transition(state: Journey, event: Event): Journey {
  const requireStage = (stage: Stage) => {
    if (state.stage !== stage)
      throw new FlowError('Complete the current step before continuing.');
  };
  switch (event.type) {
    case 'reset':
      return createJourney();
    case 'load_sample':
      requireStage('document');
      return freeze({
        ...createJourney(),
        stage: event.scenario === 'supported' ? 'review' : 'document',
        failure: event.scenario === 'supported' ? null : event.scenario,
      });
    case 'review':
      requireStage('review');
      if (!event.consent)
        throw new FlowError(
          'Review and accept the public disclosure before continuing.',
        );
      return freeze({
        ...state,
        amountMg: parseSampleAmount(event.grams),
        reviewed: true,
        stage: 'authorization',
        failure: null,
      });
    case 'edit_request':
      if (!['authorization', 'proof', 'mint'].includes(state.stage))
        throw new FlowError('This request cannot be edited at this step.');
      return freeze({
        ...createJourney(),
        stage: 'review',
        amountMg: state.amountMg,
      });
    case 'issuer_check':
      requireStage('authorization');
      return freeze({
        ...state,
        issuerChecks: { ...state.issuerChecks, [event.check]: event.checked },
      });
    case 'authorize':
      if (!canAuthorize(state))
        throw new FlowError(
          'Holder binding, an exclusive reservation and token rights must all be reviewed.',
        );
      return freeze({
        ...state,
        authorization: 'simulated',
        stage: 'proof',
        failure: null,
      });
    case 'reject_authorization':
      requireStage('authorization');
      return freeze({
        ...state,
        issuerChecks: { subject: false, reservation: false, rights: false },
        failure: 'issuer_rejected',
      });
    case 'prove':
      requireStage('proof');
      if (state.authorization !== 'simulated')
        throw new FlowError('Issuer approval is required before proving.');
      return freeze({
        ...state,
        proof: event.succeeds ? 'simulated' : 'missing',
        stage: event.succeeds ? 'mint' : 'proof',
        failure: event.succeeds ? null : 'proof_rejected',
      });
    case 'mint':
      requireStage('mint');
      if (state.authorization !== 'simulated' || state.proof !== 'simulated')
        throw new FlowError(
          'Approval and a verified proof are required before minting.',
        );
      return freeze({
        ...state,
        receipt: event.succeeds ? 'simulated' : 'missing',
        stage: event.succeeds ? 'receipt' : 'mint',
        failure: event.succeeds ? null : 'wallet_rejected',
      });
  }
}
