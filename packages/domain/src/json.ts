/** Bound raw JSON and reject repeated decoded keys before callers normalize it. */
export function parseDuplicateFreeJson(
  input: unknown,
  maxBytes: number,
): unknown {
  if (typeof input !== 'string')
    throw new SyntaxError('JSON input must be a string.');
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    input.length > maxBytes ||
    new TextEncoder().encode(input).byteLength > maxBytes
  )
    throw new RangeError('JSON input exceeds its byte limit.');
  try {
    const value: unknown = JSON.parse(input);
    const objects: Set<string>[] = [];
    // Native parsing already checked grammar. String tokens hide braces inside
    // values; a following colon identifies an object key, including in arrays.
    for (const token of input.matchAll(
      /("(?:[^"\\]|\\[\s\S])*")\s*(:)?|[{}]/g,
    )) {
      if (token[0] === '{') objects.push(new Set());
      else if (token[0] === '}') objects.pop();
      else if (token[2]) {
        const keys = objects.at(-1)!;
        const key = JSON.parse(token[1]!) as string;
        if (keys.has(key)) throw new SyntaxError();
        keys.add(key);
      }
    }
    return value;
  } catch {
    // Do not expose native diagnostics, property names or snippets of input.
    throw new SyntaxError('JSON input is invalid or contains duplicate keys.');
  }
}
