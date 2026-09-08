import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const bundle = await build({
  entryPoints: ['preview/entry.tsx'],
  bundle: true,
  minify: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: 'tsconfig.json',
  legalComments: 'inline',
});
const css =
  (await readFile('app/base.css', 'utf8')) +
  '\n' +
  (await readFile('app/blueprint.css', 'utf8'));
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Ultratokenizer modules, trust boundaries and auditable issuance"><title>Ultratokenizer — Architecture Blueprint</title><style>${css}</style></head><body><div id="root"></div><noscript>Enable JavaScript to explore this blueprint.</noscript><script>${js}</script></body></html>`;
await mkdir('public', { recursive: true });
await writeFile('public/ultratokenizer-blueprint.html', html);
console.log(
  `Standalone blueprint: ${Math.round(Buffer.byteLength(html) / 1024)} KB`,
);
