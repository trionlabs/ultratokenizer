import {
  TOKEN_HEADER,
  GatewayError,
  forwardJson,
  jsonError,
  publicOrigin,
  validToken,
} from './policy.mjs';

export async function handleGateway(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/'))
    return env.ASSETS.fetch(request);
  try {
    const origin = publicOrigin(env.PUBLIC_ORIGIN);
    const backend = publicOrigin(env.DOCUMENT_SERVICE_ORIGIN);
    if (
      url.origin !== origin ||
      url.search ||
      url.hash ||
      backend === origin ||
      !validToken(env.DOCUMENT_GATEWAY_TOKEN)
    )
      throw new GatewayError(503, 'service_unavailable');
    const headers = new Headers({ [TOKEN_HEADER]: env.DOCUMENT_GATEWAY_TOKEN });
    const suppliedOrigin = request.headers.get('origin');
    if (suppliedOrigin) headers.set('origin', suppliedOrigin);
    // Access is an optional additional origin boundary; the bridge always
    // independently authenticates the gateway token, even without Access.
    if (env.ACCESS_CLIENT_ID || env.ACCESS_CLIENT_SECRET) {
      if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET)
        throw new GatewayError(503, 'service_unavailable');
      headers.set('CF-Access-Client-Id', env.ACCESS_CLIENT_ID);
      headers.set('CF-Access-Client-Secret', env.ACCESS_CLIENT_SECRET);
    }
    return await forwardJson({
      request,
      path: url.pathname,
      expectedOrigin: origin,
      upstreamOrigin: backend,
      headers,
      fetchImpl,
    });
  } catch (error) {
    return error instanceof GatewayError
      ? jsonError(error.status, error.code)
      : jsonError();
  }
}

const worker = {
  fetch(request, env) {
    return handleGateway(request, env);
  },
};

export default worker;
