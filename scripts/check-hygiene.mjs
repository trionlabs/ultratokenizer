import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const deleted = new Set(
  git('ls-files', '--deleted', '-z').split('\0').filter(Boolean),
);
const files = [
  ...new Set(
    git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
      .split('\0')
      .filter((file) => file && !deleted.has(file)),
  ),
];
const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
  input: tracked.join('\n') + '\n',
  encoding: 'utf8',
});
if (ignored.status !== 0 && ignored.status !== 1) {
  throw new Error(ignored.stderr || 'Unable to evaluate ignore rules.');
}

const failures = ignored.stdout.trim()
  ? ignored.stdout
      .trim()
      .split('\n')
      .map((file) => `${file}: tracked but ignored`)
  : [];
const rules = [
  [
    'non-English characters',
    /[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/u,
  ],
  ['absolute home path', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[\w.-]+/],
  [
    'personal email address',
    /[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|protonmail|proton)\.[a-z]+/i,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];
for (const file of files) {
  // Inspect a symlink's target text without following it into private files.
  const content = lstatSync(file).isSymbolicLink()
    ? Buffer.from(readlinkSync(file))
    : readFileSync(file);
  for (const [label, pattern] of rules) {
    if (
      pattern.test(file) ||
      (!content.includes(0) && pattern.test(content.toString('utf8')))
    ) {
      failures.push(`${file}: ${label}`);
    }
  }
}

const metadata = git('log', '--format=%ae%n%ce', 'HEAD').trim().split('\n');
if (
  metadata.some(
    (email) =>
      !/^[^@\s]+@(?:[\w.-]*users\.noreply\.github\.com|[\w.-]+\.invalid)$/.test(
        email,
      ),
  )
) {
  failures.push(
    'Commit history contains an email outside the no-reply policy.',
  );
}
const messages = git('log', '--format=%B', 'HEAD');
for (const [label, pattern] of rules) {
  if (pattern.test(messages)) failures.push(`Commit messages: ${label}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Repository hygiene passed (${files.length} tracked or unignored new files; ${deleted.size} deleted paths omitted).`,
  );
}
