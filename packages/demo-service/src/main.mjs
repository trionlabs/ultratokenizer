import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RuntimeAdapter } from './runtime.mjs';
import { JobStore } from './store.mjs';
import { DemoService } from './service.mjs';
import { createApiServer } from './http.mjs';
import { stopSubprocesses } from './io.mjs';

process.umask(0o077);
let store;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'resume-prepared-proof': { type: 'string' },
      'resume-submitted-proof': { type: 'string' },
    },
  });
  const recoveryId = values['resume-prepared-proof'];
  const submittedId = values['resume-submitted-proof'];
  if (
    positionals.length !== 1 ||
    (recoveryId !== undefined && !/^[0-9a-f]{64}$/.test(recoveryId)) ||
    (submittedId !== undefined && !/^[0-9a-f]{64}$/.test(submittedId)) ||
    (recoveryId !== undefined && submittedId !== undefined)
  )
    throw new Error('A private configuration file is required.');
  const runtime = await RuntimeAdapter.load(
    process.cwd(),
    resolve(positionals[0]),
  );
  store = await new JobStore(runtime.path('storePath')).open();
  const service = new DemoService(runtime, store);
  const server = createApiServer(service, runtime.config);
  server.listen(runtime.config.port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        status: 'local-demo-service-listening',
        port: runtime.config.port,
        operationsEnabled: runtime.config.operationsEnabled,
      }),
    );
    if (recoveryId) {
      void service.resumePreparedProof(recoveryId).then(
        (status) =>
          console.log(
            JSON.stringify({
              status: 'prepared-proof-continuation-started',
              jobId: recoveryId,
              phase: status.phase,
            }),
          ),
        () =>
          console.error(
            'Prepared proof continuation was refused. Existing artifacts were retained; review the job before any further action.',
          ),
      );
    }
    if (submittedId) {
      void service.resumeSubmittedProof(submittedId).then(
        () =>
          console.log(
            JSON.stringify({
              status: 'submitted-proof-observation-started',
              jobId: submittedId,
            }),
          ),
        () =>
          console.error(
            'Submitted proof observation was refused. The existing request and budget were retained; no replacement was submitted.',
          ),
      );
    }
  });
  const stop = () => {
    stopSubprocesses();
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.on('error', async () => {
    await store.close();
    console.error('Local demo service could not listen.');
    process.exitCode = 1;
  });
} catch {
  if (store) await store.close();
  console.error(
    'Local demo service could not start. Review its private configuration and process lock.',
  );
  process.exitCode = 1;
}
