import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBridgeConfig } from './config.mjs';
import { createPublicBridge } from './bridge.mjs';

export async function startBridge(path, root = process.cwd()) {
  const config = await loadBridgeConfig(await realpath(root), path);
  const server = createPublicBridge(config);
  await new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolveStart);
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3) throw new Error('Invalid arguments.');
    const server = await startBridge(process.argv[2]);
    process.stdout.write('Public API bridge listening on loopback.\n');
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    // Configuration failures may contain local credential paths. Never print
    // exception details, the configuration object, or the shared token.
    process.stderr.write(
      'Public API bridge could not start; check the reviewed local configuration.\n',
    );
    process.exitCode = 1;
  }
}
