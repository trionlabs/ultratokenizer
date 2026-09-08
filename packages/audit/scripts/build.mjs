import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'test/audit.test': 'test/audit.test.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
