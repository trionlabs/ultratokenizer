import assert from 'node:assert/strict';
import test from 'node:test';
import { hygieneIssues } from './hygiene-rules.mjs';

const privateHeader = ['-----BEGIN ', 'ENCRYPTED ', 'PRIVATE KEY-----'].join(
  '',
);
const homePath = ['', 'Users', 'example', 'private.txt'].join('/');
const email = ['example', 'fastmail.com'].join('@');

await test('detects private patterns in text, escaped strings and binary containers', () => {
  const encoded = privateHeader
    .split('')
    .map(
      (character) =>
        '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
    )
    .join('');
  for (const input of [
    Buffer.from(privateHeader),
    Buffer.from(encoded),
    Buffer.concat([Buffer.from([0, 1]), Buffer.from(privateHeader)]),
    Buffer.from(privateHeader, 'utf16le'),
    Buffer.from(privateHeader, 'utf16le').swap16(),
  ]) {
    assert.ok(hygieneIssues(input).includes('private key'));
  }
});

await test('detects additional personal email and home-path representations', () => {
  for (const value of [
    homePath,
    ['C:', 'Users', 'example'].join('/'),
    JSON.stringify(['C:', 'Users', 'example'].join('\\')),
    ['c:', 'Users', 'example'].join('\\'),
    ['~example', 'private'].join('/'),
  ]) {
    assert.ok(hygieneIssues(Buffer.from(value)).includes('absolute home path'));
  }
  assert.ok(
    hygieneIssues(Buffer.from(email)).includes('personal email address'),
  );
});

await test('language heuristic checks non-Latin source scripts without treating binary bytes as prose', () => {
  for (const codepoint of [0x011f, 0x041f, 0x4e2d]) {
    assert.ok(
      hygieneIssues(Buffer.from(String.fromCodePoint(codepoint))).includes(
        'source-language heuristic',
      ),
    );
  }
  assert.deepEqual(hygieneIssues(Buffer.from([0, 0x81, 0xff, 0x91])), []);
});

await test('ordinary project URLs, fixture addresses and English text stay allowed', () => {
  assert.deepEqual(
    hygieneIssues(
      Buffer.from(
        'https://github.com/example/repo test@example.invalid English text',
      ),
    ),
    [],
  );
});
