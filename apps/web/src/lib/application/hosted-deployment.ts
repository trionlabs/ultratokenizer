import { MAX_DEPLOYMENT_BYTES } from '../issuance';

/** The app operator supplies trust configuration; evidence cannot select its URL. */
export async function fetchHostedDeployment(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetcher('/deployment.json', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (
    !response.ok ||
    response.redirected ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('The app network configuration is unavailable.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DEPLOYMENT_BYTES)
        throw new Error('The app network configuration is too large.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
