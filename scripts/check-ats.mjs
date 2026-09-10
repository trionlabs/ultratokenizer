import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, { env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (capture) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.signal ?? result.status}).`);
  return result.stdout ?? '';
}

// This command is the mandatory local-contract lane. Its explicit artifact
// directory makes missing or invalid build output fail rather than skip a test.
run(process.env.ANVIL_BIN ?? 'anvil', ['--version']);
run(process.execPath, ['contracts/ats/scripts/build.mjs']);
run(process.execPath, ['contracts/ats/scripts/verify-build.mjs']);
run('npm', ['--prefix', 'contracts/ats', 'test']);
run('npm', ['--prefix', 'packages/issuance', 'run', 'build']);
const localCase =
  'actual pinned ATS contracts pass the reader through an ephemeral local Anvil';
const output = run(
  process.execPath,
  [
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern',
    `^${localCase}$`,
    'packages/issuance/dist/test/ats.test.js',
  ],
  {
    capture: true,
    env: {
      ...process.env,
      ULTRATOKENIZER_ATS_LOCAL_ARTIFACTS: join(root, 'contracts/ats/build'),
    },
  },
);
if (
  !new RegExp(`^ok \\d+ - ${localCase}$`, 'm').test(output) ||
  !/^# skipped 0$/m.test(output) ||
  !/^# fail 0$/m.test(output) ||
  Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0) < 6
)
  throw new Error(
    'The required ATS local acceptance cases did not all execute.',
  );
