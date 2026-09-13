import { realpath } from 'node:fs/promises';
import {
  check,
  confined,
  exact,
  readJson,
  readOwned,
  sha256,
} from '../src/io.mjs';
import { publicOrigin, validToken } from './policy.mjs';

async function localFile(root, path) {
  const file = confined(root, path);
  check((await realpath(file)) === file);
  return file;
}

export async function loadBridgeConfig(root, path) {
  root = await realpath(root);
  const value = exact(await readJson(await localFile(root, path), 16 * 1024), [
    'format',
    'publicOrigin',
    'port',
    'serviceConfigPath',
    'serviceConfigSha256',
    'deploymentSha256',
    'manifestSha256',
    'gatewayTokenPath',
  ]);
  check(value.format === 'ultratokenizer.public-bridge.v1');
  publicOrigin(value.publicOrigin);
  const servicePath = await localFile(root, value.serviceConfigPath);
  check(sha256(await readOwned(servicePath)) === value.serviceConfigSha256);
  const service = await readJson(servicePath);
  check(service.format === 'ultratokenizer.demo-service.v1');
  const deploymentPath = await localFile(root, service.deploymentPath);
  const manifestPath = await localFile(root, service.manifestPath);
  check(sha256(await readOwned(deploymentPath)) === value.deploymentSha256);
  check(sha256(await readOwned(manifestPath)) === value.manifestSha256);
  const manifest = await readJson(manifestPath);
  check(Array.isArray(manifest.runs) && manifest.runs.length === 10);
  const deployment = await readJson(deploymentPath);
  // This adapter publishes only the admitted Hedera document-demo profile.
  // A different chain or policy requires a separate explicit review.
  check(
    deployment.auditPolicy?.chainId === '296' &&
      deployment.auditPolicy?.policyVersion === '2',
  );
  const secret = exact(
    await readJson(await localFile(root, value.gatewayTokenPath), 1024),
    ['format', 'token'],
  );
  check(
    secret.format === 'ultratokenizer.gateway-secret.v1' &&
      validToken(secret.token),
  );
  return {
    origin: value.publicOrigin,
    port: value.port,
    upstreamPort: service.port,
    localOrigin: service.origin,
    token: secret.token,
  };
}
