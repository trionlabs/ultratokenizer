import {
  getIssuanceRequestDigest,
  parseIssuanceRequest,
  type IssuanceRequest,
} from '../../../../../packages/domain/src/index.js';
import type { Journey } from '../domain/journey';
import { sampleRequest } from './sample-request';

export const MAX_RECEIPT_BYTES = 64 * 1024;
const format = 'ultratokenizer.sample-receipt.v1';
const unavailable = {
  evidence: 'not-connected',
  issuer: 'not-connected',
  proof: 'not-connected',
  chain: 'not-connected',
} as const;

export type SampleReceipt = Readonly<{
  format: typeof format;
  mode: 'simulation';
  request: IssuanceRequest;
  requestDigest: string;
  integrations: typeof unavailable;
}>;

export function createSampleReceipt(journey: Journey): SampleReceipt {
  if (journey.receipt !== 'simulated')
    throw new Error('Complete the sample journey before exporting a receipt.');
  const request = sampleRequest(journey.amountMg);
  return Object.freeze({
    format,
    mode: 'simulation',
    request,
    requestDigest: getIssuanceRequestDigest(request),
    integrations: Object.freeze({ ...unavailable }),
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('This is not a supported sample receipt.');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('The sample receipt has unexpected or missing fields.');
}

/** Checks internal request consistency, never issuer authenticity or a mint. */
export function verifySampleReceipt(text: string): SampleReceipt {
  if (new TextEncoder().encode(text).byteLength > MAX_RECEIPT_BYTES)
    throw new Error('Choose a sample receipt smaller than 64 KB.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('The receipt must be valid JSON.');
  }
  const input = object(decoded);
  exactKeys(input, [
    'format',
    'mode',
    'request',
    'requestDigest',
    'integrations',
  ]);
  if (input.format !== format || input.mode !== 'simulation')
    throw new Error('Only Ultratokenizer simulation receipts are supported.');
  const integrations = object(input.integrations);
  exactKeys(integrations, Object.keys(unavailable));
  if (Object.values(integrations).some((value) => value !== 'not-connected'))
    throw new Error('A sample receipt cannot claim connected integrations.');
  const request = parseIssuanceRequest(input.request);
  const requestDigest = getIssuanceRequestDigest(request);
  if (input.requestDigest !== requestDigest)
    throw new Error(
      'Request digest mismatch. The request or digest was changed.',
    );
  return Object.freeze({
    format,
    mode: 'simulation',
    request,
    requestDigest,
    integrations: Object.freeze({ ...unavailable }),
  });
}
