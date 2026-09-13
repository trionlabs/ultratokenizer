import { resolve } from 'node:path';
import { RuntimeAdapter } from './runtime.mjs';
import { JobStore } from './store.mjs';
import { DemoService } from './service.mjs';
import { createApiServer } from './http.mjs';
import { stopSubprocesses } from './io.mjs';

process.umask(0o077);
let store;
try {
  if (process.argv.length !== 3)
    throw new Error('A private configuration file is required.');
  const runtime = await RuntimeAdapter.load(
    process.cwd(),
    resolve(process.argv[2]),
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
