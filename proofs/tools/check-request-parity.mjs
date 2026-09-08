/** Compare independent TypeScript/viem and Rust validation/digests on adversarial inputs. */
import { getIssuanceRequestDigest } from '../../dist/domain/src/request-digest.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const baseline = JSON.parse(
  readFileSync(new URL('claim-evidence/fixtures/request.synthetic.json', root)),
);
const maximum = (1n << 256n) - 1n;
const cases = [baseline];
for (const [field, values] of Object.entries({
  schemaVersion: ['2', 1],
  action: ['MINT', 'issue'],
  unit: ['XAU_GRAM', 'xau_milligram'],
  amount: [
    '0',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e3',
    ' 1',
    '',
    String(maximum),
    String(maximum + 1n),
  ],
  chainId: ['0', '1', String(maximum)],
  nonce: ['0', '1', String(maximum), String(maximum + 1n)],
  policyVersion: ['0', '1', '18446744073709551615', '18446744073709551616'],
  validUntil: ['0', '1', '18446744073709551615', '18446744073709551616'],
  gate: [
    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD',
    '0x0000000000000000000000000000000000000000',
  ],
  requestId: [`0x${'AB'.repeat(32)}`, `0x${'00'.repeat(32)}`, '0x00'],
})) {
  for (const value of values) cases.push({ ...baseline, [field]: value });
}
cases.push({ ...baseline, extra: 'unsupported' });
const missing = { ...baseline };
delete missing.amount;
cases.push(missing);
const temporary = mkdtempSync(join(tmpdir(), 'ultratokenizer-parity-'));
try {
  const path = join(temporary, 'request.json');
  for (const candidate of cases) {
    let expected;
    try {
      expected = getIssuanceRequestDigest(candidate);
    } catch {
      expected = undefined;
    }
    writeFileSync(path, JSON.stringify(candidate), { mode: 0o600 });
    const actual = spawnSync(
      new URL('target/debug/ultratokenizer-claim-runner', root).pathname,
      ['request-digest', path],
      { encoding: 'utf8' },
    );
    if (actual.error || (actual.status === 0) !== Boolean(expected))
      throw new Error(
        'Canonical request acceptance differs between TypeScript and Rust.',
      );
    if (expected && JSON.parse(actual.stdout).requestDigest !== expected)
      throw new Error(
        'EIP-712 request digest differs between TypeScript and Rust.',
      );
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      cases: cases.length,
      implementations: ['typescript-viem', 'rust-tiny-keccak'],
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
