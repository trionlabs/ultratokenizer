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

await test('PNG metadata is still scanned while compressed pixel data is not', () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, body) => {
    const data = Buffer.from(body);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    // The scan never validates CRCs, so a fixed placeholder keeps this readable.
    return Buffer.concat([header, data, Buffer.alloc(4)]);
  };
  const png = (...chunks) => Buffer.concat([signature, ...chunks]);
  // Built from parts so this file does not itself carry a literal home path.
  const noise = [' ~noise', homePath].join('/');

  // A tool that writes a path into an image writes it into a text chunk.
  assert.ok(
    hygieneIssues(
      png(chunk('IHDR', 'x'.repeat(13)), chunk('tEXt', `Source${homePath}`)),
    ).includes('absolute home path'),
  );

  // The same bytes inside IDAT are DEFLATE output, not prose.
  assert.deepEqual(
    hygieneIssues(png(chunk('IHDR', 'x'.repeat(13)), chunk('IDAT', noise))),
    [],
  );

  // Anything that does not parse cleanly as PNG keeps the whole-file scan.
  const truncated = png(chunk('IDAT', noise)).subarray(0, -3);
  assert.ok(hygieneIssues(truncated).includes('absolute home path'));
  const notPng = Buffer.from(noise);
  assert.ok(hygieneIssues(notPng).includes('absolute home path'));
});
