/**
 * Renders the tracked brand raster assets: the Open Graph card and the Apple
 * touch icon. Social platforms and iOS will not accept the site's SVG mark, so
 * these are PNGs produced once from the same palette the application uses.
 *
 * This is NOT part of `npm run build`: it needs a browser binary, and the
 * outputs are committed design artifacts rather than derived configuration.
 * Run it after a brand change:
 *
 *   npm --prefix apps/web run brand:render
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { SITE_CHAIN, SITE_ORIGIN } from '../src/lib/site-meta.js';

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '../static');

// The application's own tokens, from src/issuance.css.
const palette = {
  canvas: '#f7f6f9',
  paper: '#fdfcfe',
  ink: '#302b38',
  muted: '#736c7e',
  line: '#e4e0e9',
  accent: '#75628f',
  accentSoft: '#eeebf2',
  iris: '#88769f',
};

// 'DM Sans' is named in the stylesheet but no font file is served under the
// site's `font-src 'self'` policy, so the live pages render in the system
// stack. These assets use the same stack rather than a font nobody sees.
const stack =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

// The UT monogram, identical to static/favicon.svg: a T interlocked with a U
// drawn as rectangles on one square field. Kept inline because the screenshot
// needs real markup, not a file reference.
const monogram = (
  size,
) => `<svg width="${size}" height="${size}" viewBox="0 0 720 720" aria-hidden="true">
    <rect width="720" height="720" fill="${palette.ink}"/>
    <g fill="${palette.accentSoft}">
      <rect x="72" y="96" width="576" height="120"/>
      <rect x="300" y="216" width="120" height="227"/>
      <rect x="72" y="276" width="120" height="347"/>
      <rect x="528" y="276" width="120" height="347"/>
      <rect x="72" y="503" width="576" height="120"/>
    </g>
  </svg>`;

const shell = (body, css) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:${stack};color:${palette.ink};-webkit-font-smoothing:antialiased}
  svg{display:block;flex:0 0 auto}
  ${css}
</style></head><body>${body}</body></html>`;

const ogCard = shell(
  `<div class="card">
    <div class="brand">
      ${monogram(62)}
      <span class="wordmark">ultratokenizer<i>.</i></span>
      <span class="rule"></span>
      <span class="descriptor">zkPDF-backed token issuance</span>
      <span class="url">${SITE_ORIGIN.replace('https://', '')}</span>
    </div>
    <h1>A contract that refuses to mint<br>unless every input agrees.</h1>
    <p>An authenticated gold-right document, an SP1 Groth16 proof, an institution
      permit and the holder's signature — checked together, in one atomic
      transaction, before any supply exists.</p>
    <div class="chips">
      <span>${SITE_CHAIN.name} · ${SITE_CHAIN.id}</span>
      <span>Asset Tokenization Studio</span>
      <span>SP1 Groth16</span>
      <span>ERC-8004 identity</span>
    </div>
  </div>`,
  `.card{width:1200px;height:630px;padding:64px 72px;background:${palette.canvas};
     display:flex;flex-direction:column;position:relative;overflow:hidden}
   .card::after{content:'';position:absolute;right:-160px;top:-160px;width:620px;height:620px;
     border-radius:50%;background:${palette.accentSoft}}
   .brand,.chips,.card>*{position:relative;z-index:1}
   .brand{display:flex;align-items:center;gap:14px}
   .wordmark{font-size:34px;font-weight:700;letter-spacing:-0.04em}
   .wordmark i{margin-left:-4px;color:${palette.iris};font-style:normal}
   .rule{width:1px;height:26px;background:${palette.line};margin-left:6px}
   .descriptor{color:${palette.muted};font-size:19px}
   h1{margin-top:auto;font-size:68px;line-height:1.1;font-weight:700;letter-spacing:-0.035em}
   p{margin-top:26px;max-width:880px;color:${palette.muted};font-size:25px;line-height:1.5}
   .chips{margin-top:auto;padding-top:34px;display:flex;gap:12px;flex-wrap:wrap}
   .chips span{padding:9px 18px;border:1px solid ${palette.line};border-radius:999px;
     background:${palette.paper};color:${palette.ink};font-size:19px}
   .url{margin-left:auto;color:${palette.muted};font-size:19px}`,
);

// iOS applies its own corner mask, so the monogram is rendered full bleed.
const touchIcon = shell(
  `<div class="icon">${monogram(180)}</div>`,
  `.icon{width:180px;height:180px;display:grid;place-items:center}`,
);

const browser = await chromium.launch();
try {
  for (const [name, html, width, height] of [
    ['og.png', ogCard, 1200, 630],
    ['apple-touch-icon.png', touchIcon, 180, 180],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'load' });
    await writeFile(join(staticRoot, name), await page.screenshot());
    await page.close();
    process.stdout.write(`rendered static/${name} (${width}x${height})\n`);
  }
} finally {
  await browser.close();
}
