import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

/** Resolve the same source imports used by the browser, without checked-in build output. */
export async function loadModule(relative) {
  const scratch = await mkdtemp(join(tmpdir(), 'ultratokenizer-web-test-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(new URL(relative, import.meta.url)),
        outDir: scratch,
        target: 'esnext',
        rollupOptions: { output: { entryFileNames: 'module.mjs' } },
      },
    });
    return await import(pathToFileURL(join(scratch, 'module.mjs')).href);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
