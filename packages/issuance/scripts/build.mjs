import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const tests = (await readdir(new URL('../test/', import.meta.url))).filter(
  (name) => name.endsWith('.test.ts'),
);
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: {
    index: 'src/index.ts',
    ...Object.fromEntries(
      tests.map((name) => [`test/${name.slice(0, -3)}`, `test/${name}`]),
    ),
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
