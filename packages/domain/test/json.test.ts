import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from '../fixtures/request.synthetic.json' with { type: 'json' };
import {
  getIssuanceRequestDigest,
  parseDuplicateFreeJson,
  parseIssuanceRequestJson,
  RequestValidationError,
} from '../src/index.js';
import { requestJsonCases } from './request-json-cases.js';

const smile = String.fromCodePoint(0x1f600);
const accentedE = String.fromCodePoint(0xe9);

await test('raw JSON preserves native strings, values, arrays and object scopes', () => {
  const inputs = [
    'null',
    'true',
    'false',
    '0',
    '-0.25e+2',
    '"braces { } and colon :"',
    '"escaped quote \\" and slash \\\\"',
    '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}',
    '[{"a":1},[null,{"a":2}],"a",{}]',
    '{"a\\\"b":1,"a\\\\b":2,"a:b":3,"{":4,"}":5}',
    `{"${String.fromCodePoint(0x96ea)}":"${String.fromCodePoint(0x2603)}","\\uD83D\\uDE00":"${smile}","${accentedE}":1,"e${String.fromCodePoint(0x301)}":2}`,
    '{"__proto__":{"safe":true},"constructor":1,"toString":2}',
    ' \n\t { "a" \r : [true, false] } \n ',
  ];
  for (const input of inputs)
    assert.deepEqual(parseDuplicateFreeJson(input, 4096), JSON.parse(input));
});

await test('raw JSON rejects duplicate decoded keys at every object depth', () => {
  for (const input of [
    '{"a":1,"a":1}',
    '{"a":1,"\\u0061":2}',
    '{"outer":{"x":1,"x":2}}',
    '[{},[{"x":1,"\\u0078":2}]]',
    '{"left":{"x":1},"right":{"y":1,"y":2}}',
    '{"a\\\"b":1,"a\\u0022b":2}',
    '{"a\\\\b":1,"a\\u005Cb":2}',
    `{"${smile}":1,"\\uD83D\\uDE00":2}`,
    '{"__proto__":1,"__proto__":2}',
  ])
    assert.throws(() => parseDuplicateFreeJson(input, 4096), SyntaxError);
});

await test('raw JSON errors are sanitized and byte limits apply before parsing', () => {
  const marker = 'private-input-marker';
  for (const input of [
    undefined,
    null,
    {},
    '',
    `{"${marker}":`,
    `{"${marker}":1,"${marker}":2}`,
    '{"a":1,}',
    '[1,]',
    '{"a":"\\x"}',
    '[] null',
    '"unterminated',
  ]) {
    assert.throws(
      () => parseDuplicateFreeJson(input, 4096),
      (error: unknown) => {
        assert.ok(error instanceof SyntaxError);
        assert.equal(error.message.includes(marker), false);
        return true;
      },
    );
  }
  assert.equal(parseDuplicateFreeJson(`"${accentedE}"`, 4), accentedE);
  assert.throws(() => parseDuplicateFreeJson(`"${accentedE}"`, 3), RangeError);
  assert.equal(parseDuplicateFreeJson('null', 4), null);
  assert.throws(() => parseDuplicateFreeJson('null ', 4), RangeError);
  for (const limit of [0, -1, NaN, Infinity, 4.5])
    assert.throws(() => parseDuplicateFreeJson('null', limit), RangeError);
});

await test('raw request acceptance retains canonical digests and rejects ambiguous texts', () => {
  const expected = getIssuanceRequestDigest(fixture);
  for (const candidate of requestJsonCases(fixture)) {
    if (candidate.accepted) {
      const parsed = parseIssuanceRequestJson(candidate.json);
      assert.equal(getIssuanceRequestDigest(parsed), expected, candidate.name);
      assert.equal(Object.isFrozen(parsed), true);
    } else {
      assert.throws(
        () => parseIssuanceRequestJson(candidate.json),
        RequestValidationError,
        candidate.name,
      );
    }
  }
  assert.throws(
    () => parseIssuanceRequestJson(' '.repeat(4097)),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.code, 'input_too_large');
      assert.equal(error.field, '$');
      return true;
    },
  );
  assert.throws(
    () => parseIssuanceRequestJson('{"private-marker":'),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.code, 'invalid_json');
      assert.equal(error.message.includes('private-marker'), false);
      return true;
    },
  );
});
