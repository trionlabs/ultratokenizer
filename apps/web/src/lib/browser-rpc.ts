export const browserRpcMessage =
  'Use HTTPS, or HTTP at localhost or 127.0.0.1.';

export class BrowserRpcError extends Error {
  constructor() {
    super(browserRpcMessage);
    this.name = 'BrowserRpcError';
  }
}

/** Match the static page's CSP; shared Node clients retain their IPv6 support. */
export function parseBrowserRpcUrl(input: unknown): string {
  try {
    if (typeof input !== 'string' || input.length > 2048) throw new Error();
    const url = new URL(input);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        ))
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new BrowserRpcError();
  }
}
