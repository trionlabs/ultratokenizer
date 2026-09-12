import { open, rename, rm, mkdir } from 'node:fs/promises';
import {
  MAX_DEPLOYMENT_BYTES,
  parseDeploymentConfig,
} from '../packages/issuance/dist/index.js';

// Run through `npm run prepare:web` so the shared schema is freshly compiled.
const input = new URL(
  '../work/runtime/hedera-testnet/deployment.json',
  import.meta.url,
);
const output = new URL('../apps/web/static/deployment.json', import.meta.url);
let ownsPending = false;
const pending = new URL(
  '../apps/web/static/deployment.json.pending',
  import.meta.url,
);
try {
  const file = await open(input, 'r');
  let config;
  try {
    if (!(await file.stat()).isFile()) throw new Error('invalid input');
    const buffer = Buffer.alloc(MAX_DEPLOYMENT_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      );
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_DEPLOYMENT_BYTES) throw new Error('oversized input');
    config = parseDeploymentConfig(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, bytes),
      ),
    );
  } finally {
    await file.close();
  }
  // This export lane admits the documented public Hedera testnet endpoint only.
  // A generic URL filter cannot identify access tokens hidden in a URL path.
  if (
    config.rpcUrl !== 'https://testnet.hashio.io/api' ||
    config.auditPolicy.chainId !== '296'
  )
    throw new Error('unreviewed public RPC endpoint');
  await mkdir(new URL('../apps/web/static/', import.meta.url), {
    recursive: true,
  });
  const staged = await open(pending, 'wx', 0o600);
  ownsPending = true;
  try {
    await staged.writeFile(JSON.stringify(config, null, 2) + '\n');
    await staged.sync();
  } finally {
    await staged.close();
  }
  await rename(pending, output);
  ownsPending = false;
  console.log(
    'Prepared public app configuration. Rebuild the web app to include it.',
  );
  console.log('Schema validation does not establish live contract admission.');
} catch {
  console.error(
    'Preparation failed; any previous public configuration is unchanged. Check work/runtime/hedera-testnet/deployment.json and use the documented public Hedera testnet endpoint.',
  );
  process.exitCode = 1;
} finally {
  if (ownsPending) await rm(pending, { force: true });
}
