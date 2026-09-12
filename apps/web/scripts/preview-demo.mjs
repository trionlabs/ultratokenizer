import { createHash } from 'node:crypto';
import { constants, rmSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { preview } from 'vite';

async function regularEntry(path) {
  const stat = await lstat(path);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Preview refuses symlinks and special files: ${path}`);
  }
  return stat;
}

async function manifest(directory) {
  if (!(await regularEntry(directory)).isDirectory()) {
    throw new Error(`Preview requires a directory: ${directory}`);
  }
  const files = [];
  async function visit(relative = '') {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const entry = join(relative, name);
      const path = join(directory, entry);
      if ((await regularEntry(path)).isDirectory()) {
        await visit(entry);
      } else {
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          files.push([
            entry,
            createHash('sha256')
              .update(await file.readFile())
              .digest('hex'),
          ]);
        } finally {
          await file.close();
        }
      }
    }
  }
  await visit();
  if (!files.some(([name]) => name === 'index.html')) {
    throw new Error(
      'Preview requires build/index.html. Run the web build first.',
    );
  }
  return JSON.stringify(files);
}

export async function snapshotBuild(source, scratch) {
  const before = await manifest(source);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  if (!(await regularEntry(scratch)).isDirectory()) {
    throw new Error(`Preview requires a scratch directory: ${scratch}`);
  }
  const snapshot = await mkdtemp(join(scratch, 'preview-demo-'));
  try {
    await cp(source, snapshot, {
      recursive: true,
      dereference: false,
      filter: async (path) => {
        await regularEntry(path);
        return true;
      },
    });
    await chmod(snapshot, 0o700);
    if (
      before !== (await manifest(source)) ||
      before !== (await manifest(snapshot))
    ) {
      throw new Error(
        'Build changed while copying. Finish the build and retry.',
      );
    }
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: { port: { type: 'string', default: '4173' } },
  });
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  const web = fileURLToPath(new URL('../', import.meta.url));
  const headers = {};
  const policy = await readFile(join(web, 'static/_headers'), 'utf8');
  if (!policy.startsWith('/*\n')) {
    throw new Error('Preview expects one global /* block in static/_headers.');
  }
  for (const line of policy.split('\n').slice(1).filter(Boolean)) {
    const header = /^\s+([^:\s]+):\s*(.+)$/.exec(line);
    if (!header) throw new Error(`Unsupported static/_headers rule: ${line}`);
    headers[header[1]] = header[2];
  }
  headers['Cache-Control'] = 'no-store';
  let snapshot;
  let interrupted = 0;
  // Let an in-progress copy finish its own cleanup before honoring a shutdown.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(signal, () => {
      interrupted = code;
      if (snapshot) process.exit(code);
    });
  }
  process.once('exit', () => {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  });
  snapshot = await snapshotBuild(
    join(web, 'build'),
    resolve(web, '../../.scratch'),
  );
  if (interrupted) process.exit(interrupted);
  const server = await preview({
    configFile: false,
    envDir: false,
    root: web,
    publicDir: false,
    appType: 'mpa',
    build: { outDir: snapshot },
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      cors: false,
      headers,
    },
  });
  console.log(`Serving a fixed build snapshot: ${snapshot}`);
  console.log(
    'Rebuilds do not change this preview. Restart it to use a new build.',
  );
  server.printUrls();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Demo preview: ${error.message}`);
    process.exitCode = 1;
  });
}
