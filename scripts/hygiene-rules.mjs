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

export function hygieneIssues(content) {
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
