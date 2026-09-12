import { readFile } from 'node:fs/promises';
import fixture from '../fixtures/request.synthetic.json' with { type: 'json' };
import {
  assertIssuanceRequestActive,
  getIssuanceRequestDigest,
  parseIssuanceRequestJson,
  RequestValidationError,
} from '../src/index.js';

try {
  let input: unknown = fixture;
  if (process.argv[2]) {
    const contents = await readFile(process.argv[2], 'utf8');
    input = parseIssuanceRequestJson(contents);
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const request = assertIssuanceRequestActive(input, now);
  console.log(
    JSON.stringify(
      {
        source: process.argv[2] ? 'provided_request' : 'synthetic_fixture',
        status: 'request_valid',
        checkedAt: now.toString(),
        request,
        digest: getIssuanceRequestDigest(request),
        evidence: 'not_verified',
        issuerAuthority: 'not_verified',
        replayState: 'not_checked',
        chainTransaction: 'not_submitted',
      },
      null,
      2,
    ),
  );
} catch (error) {
  const result =
    error instanceof RequestValidationError
      ? {
          status: 'request_rejected',
          code: error.code,
          field: error.field,
          message: error.message,
        }
      : {
          status: 'request_rejected',
          code: 'input_unavailable',
          message: 'Unable to read the request file.',
        };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
