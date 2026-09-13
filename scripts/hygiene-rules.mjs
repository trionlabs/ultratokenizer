// Best-effort leak detection, not a general PII classifier or language proof.
const privatePatterns = [
  [
    'absolute home path',
    /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]Users[\\/])[\w.-]+|(?:^|[\s"'`(])~[\w.-]+[\\/]/,
  ],
  [
    'personal email address',
    /[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|protonmail|proton|fastmail)\.[a-z]+/i,
  ],
  [
    'private key',
    /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  ],
];
const languageScripts =
  /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const turkishLetters = new Set([
  0x00e7, 0x011f, 0x0131, 0x00f6, 0x015f, 0x00fc, 0x00c7, 0x011e, 0x0130,
  0x00d6, 0x015e, 0x00dc,
]);

function decodeEscapes(value) {
  // Two bounded passes cover ordinary JSON/JS strings and one escaped wrapper.
  for (let pass = 0; pass < 2; pass++) {
    value = value.replace(
      /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
      (match, braced, unicode, byte) => {
        const code = Number.parseInt(braced ?? unicode ?? byte, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      },
    );
    value = value.replace(/\\\\/g, '\\').replace(/\\\//g, '/');
  }
  return value;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * A PNG's IDAT payload is DEFLATE output: arbitrary bytes that carry no prose,
 * but that do produce home-path shaped sequences by chance in any file of real
 * size. Scanning it reports leaks that are not there while
 * catching none that are, because a tool writing a path into an image writes it
 * into a tEXt, iTXt or zTXt chunk. Keep every chunk header and every non-pixel
 * chunk body; drop only the compressed image data. Anything that does not parse
 * cleanly as PNG is scanned whole.
 */
function withoutPixelData(content) {
  if (!content.subarray(0, 8).equals(PNG_SIGNATURE)) return content;
  const kept = [content.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= content.length) {
    const length = content.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > content.length || end > content.length) return content;
    const type = content.subarray(offset + 4, offset + 8);
    kept.push(type);
    if (type.toString('latin1') !== 'IDAT')
      kept.push(content.subarray(offset + 8, offset + 8 + length));
    offset = end;
  }
  return offset === content.length ? Buffer.concat(kept) : content;
}

export function hygieneIssues(rawContent) {
  const content = withoutPixelData(rawContent);
  const findings = new Set();
  const rawText = content.toString('utf8');
  const text = decodeEscapes(rawText);
  const candidates = [text];
  if (content.includes(0)) {
    // Scan readable signatures even inside binary files and UTF-16 exports.
    const evenBytes = content.subarray(
      0,
      content.length - (content.length % 2),
    );
    candidates.push(decodeEscapes(evenBytes.toString('utf16le')));
    candidates.push(
      decodeEscapes(Buffer.from(evenBytes).swap16().toString('utf16le')),
    );
    // Unicode escapes are legitimate in document parsers. This is a prose hint,
    // while private-data patterns are checked against decoded strings as well.
  } else if (
    languageScripts.test(rawText) ||
    [...rawText].some((character) =>
      turkishLetters.has(character.codePointAt(0)),
    )
  ) {
    findings.add('source-language heuristic');
  }
  for (const [label, pattern] of privatePatterns) {
    if (candidates.some((candidate) => pattern.test(candidate)))
      findings.add(label);
  }
  return [...findings];
}
