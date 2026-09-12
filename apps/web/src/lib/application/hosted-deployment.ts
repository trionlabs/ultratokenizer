import { MAX_DEPLOYMENT_BYTES } from '../issuance';

/** The app operator supplies trust configuration; evidence cannot select its URL. */
export async function fetchHostedDeployment(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  return fetchHostedJson(
    '/deployment.json',
    MAX_DEPLOYMENT_BYTES,
    signal,
    fetcher,
  );
}

/** Optional discovery never changes the deployment or the issuance client. */
export async function fetchHostedDiscovery(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  return fetchHostedJson('/discovery.json', 32 * 1024, signal, fetcher);
}

async function fetchHostedJson(
  path: '/deployment.json' | '/discovery.json',
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const response = await fetcher(path, {
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
      if (bytes > limit)
        throw new Error('The app network configuration is too large.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
