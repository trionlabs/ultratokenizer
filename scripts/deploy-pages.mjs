// Uploads the already-built static site to Cloudflare Pages.
//
// The build has to happen on a machine that holds the private deployment
// record, because scripts/prepare-web-config.mjs reads it from the Git-ignored
// work/ tree and admits only the documented public Hedera testnet endpoint.
// Handing that record to a hosted build environment would put it somewhere
// this repository does not control, so the artifact is built locally and only
// the static output is uploaded.
//
// Nothing about the target is stored here. Set CF_PAGES_PROJECT, and let
// wrangler resolve credentials from its own environment.
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

const project = process.env.CF_PAGES_PROJECT;
if (!project || !/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(project)) {
  console.error(
    'Set CF_PAGES_PROJECT to the Cloudflare Pages project name (lowercase letters, digits and hyphens).',
  );
  process.exit(1);
}

const output = 'apps/web/build';
for (const required of [`${output}/index.html`, `${output}/_headers`]) {
  try {
    await access(required);
  } catch {
    console.error(
      `Missing ${required}. Run npm run prepare:web && npm run build:web first.`,
    );
    process.exit(1);
  }
}

// _headers carries the frame, CSP and transport policy that
// apps/web/test/security-browser.mjs asserts; Pages serves it verbatim.
const result = spawnSync(
  'npx',
  ['wrangler', 'pages', 'deploy', output, '--project-name', project],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
