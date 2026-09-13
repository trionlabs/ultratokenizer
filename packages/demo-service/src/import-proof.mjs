import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RuntimeAdapter } from './runtime.mjs';
import { JobStore } from './store.mjs';
import { DemoService } from './service.mjs';
import { confined, check } from './io.mjs';
import {
  readProofImport,
  importVerifiedProof,
} from './verified-proof-import.mjs';

process.umask(0o077);
let store;
try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      review: { type: 'string' },
      'review-sha256': { type: 'string' },
    },
  });
  const root = await realpath(process.cwd());
  const config = confined(root, values.config);
  check((await realpath(config)) === config);
  const runtime = await RuntimeAdapter.load(root, resolve(config));
  const input = await readProofImport(
    runtime,
    values.review,
    values['review-sha256'],
  );
  // Opening the existing store is the process-lock boundary. Never remove a
  // running observer's lock and never launch an HTTP server from this command.
  store = new JobStore(runtime.path('storePath'));
  await store.open();
  const result = await importVerifiedProof(
    new DemoService(runtime, store),
    input,
  );
  process.stdout.write(
    JSON.stringify({
      status: 'verified-proof-import-finished',
      jobId: result.jobId,
      jobStatus: result.status,
      bundleReady: result.bundleReady,
      newProofRequestSubmitted: false,
      originalBudgetReleased: false,
    }) + '\n',
  );
} catch {
  process.stderr.write(
    'Verified proof import refused. Preserve both request journals and budgets; review the pinned artifacts and process lock.\n',
  );
  process.exitCode = 1;
} finally {
  await store?.close();
}
