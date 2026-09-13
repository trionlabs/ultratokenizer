import { setTimeout as delay } from 'node:timers/promises';
import { check, ServiceError } from './io.mjs';

/** Observe one submitted request. This function has no submission capability. */
export async function observeSubmittedRequest({
  observe,
  deadline,
  requestId,
  transactionHash,
  update,
  now = () => Math.floor(Date.now() / 1000),
  sleep = delay,
}) {
  let failures = 0;
  let status = 'queued';
  while (true) {
    if (now() >= deadline) throw new ServiceError('proof_deadline_elapsed');
    let observed;
    try {
      observed = await observe();
    } catch (error) {
      if (error?.code !== 'proof_observation_unavailable')
        throw new ServiceError('proof_request_uncertain');
      if (++failures >= 3) throw error;
      await update(status, 'proof_observation_unavailable');
      await sleep(Math.min(15000, Math.max(0, (deadline - now()) * 1000)));
      continue;
    }
    check(
      observed.status === 'exact_signed_request_observed' &&
        observed.requestId === requestId &&
        observed.transactionHash === transactionHash &&
        observed.deadlineUnix === deadline &&
        typeof observed.proofAvailable === 'boolean' &&
        typeof observed.deadlinePassed === 'boolean' &&
        Number.isInteger(observed.executionStatus) &&
        Number.isInteger(observed.fulfillmentStatus) &&
        observed.fulfillmentStatus >= 1 &&
        observed.fulfillmentStatus <= 6 &&
        (!observed.proofAvailable || observed.fulfillmentStatus === 3) &&
        observed.proofVerified === false &&
        observed.automaticRetryAllowed === false,
      'proof_request_uncertain',
    );
    failures = 0;
    // Pinned Succinct fulfillment values: 4 unfulfillable, 5 reverted,
    // 6 expired. Execution may have succeeded before a proof was rejected.
    // These outcomes never authorize a replacement request or budget release.
    if ([4, 5].includes(observed.fulfillmentStatus))
      throw new ServiceError('proof_request_rejected');
    if (observed.fulfillmentStatus === 6)
      throw new ServiceError('proof_deadline_elapsed');
    if (observed.deadlinePassed || now() >= deadline)
      throw new ServiceError('proof_deadline_elapsed');
    if (observed.proofAvailable) return observed;
    status = observed.executionStatus === 2 ? 'proving' : 'queued';
    await update(status);
    await sleep(Math.min(15000, Math.max(0, (deadline - now()) * 1000)));
  }
}
