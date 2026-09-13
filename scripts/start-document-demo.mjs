import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    'resume-prepared-proof': { type: 'string' },
    'resume-submitted-proof': { type: 'string' },
    config: {
      type: 'string',
      default: 'work/runtime/hedera-testnet/document-flow/service.json',
    },
  },
});
const configPath = resolve(root, values.config);
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
function launch(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.add(child);
  child.once('error', () => stop(1));
  child.once('exit', (code) => {
    children.delete(child);
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));
try {
  const recoveryId = values['resume-prepared-proof'];
  const submittedId = values['resume-submitted-proof'];
  if (recoveryId !== undefined && !/^[0-9a-f]{64}$/.test(recoveryId))
    throw new Error();
  if (
    (submittedId !== undefined && !/^[0-9a-f]{64}$/.test(submittedId)) ||
    (recoveryId !== undefined && submittedId !== undefined)
  )
    throw new Error();
  const info = await lstat(configPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    origin.hostname !== '127.0.0.1' ||
    origin.protocol !== 'http:' ||
    !origin.port ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    Number(origin.port) === config.port
  )
    throw new Error();
  const probe = `http://127.0.0.1:${config.port}/api/health`;
  // Refuse to pair the UI with an unrelated process already occupying the API port.
  try {
    await fetch(probe, { signal: AbortSignal.timeout(500) });
    throw new Error('occupied');
  } catch (error) {
    if (error.message === 'occupied') throw error;
  }
  launch([
    'packages/demo-service/src/main.mjs',
    configPath,
    ...(recoveryId ? ['--resume-prepared-proof', recoveryId] : []),
    ...(submittedId ? ['--resume-submitted-proof', submittedId] : []),
  ]);
  let ready = false;
  for (let i = 0; i < 30 && !stopping; i++) {
    try {
      const reply = await fetch(probe, {
        headers: { origin: config.origin },
        signal: AbortSignal.timeout(1000),
      });
      if (reply.ok && (await reply.json()).status === 'local-demo-service') {
        ready = true;
        break;
      }
    } catch {
      /* Startup remains bounded; no operations are dispatched by readiness. */
    }
    await setTimeout(500);
  }
  if (!ready || stopping) throw new Error();
  launch([
    'apps/web/scripts/preview-demo.mjs',
    '--port',
    origin.port,
    '--api-port',
    String(config.port),
  ]);
} catch {
  console.error(
    'Document demo could not start. Check the private service configuration, compiled packages, web build and unused local ports.',
  );
  stop(1);
}
