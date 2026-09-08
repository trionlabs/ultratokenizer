#!/usr/bin/env node
import { open, constants } from 'node:fs/promises';
import { auditIssuanceReceipt } from './audit.js';
import {
  AuditInputError,
  MAX_POLICY_BYTES,
  MAX_RECEIPT_BYTES,
  parseAuditPolicy,
} from './schema.js';

async function boundedFile(path: string, limit: number): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) throw new AuditInputError('unreadable');
    if (stat.size > limit) throw new AuditInputError('too_large');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      size += result.bytesRead;
      if (!result.bytesRead) break;
    }
    if (size > limit) throw new AuditInputError('too_large');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, size),
    );
  } catch (error) {
    throw error instanceof AuditInputError
      ? error
      : new AuditInputError('unreadable');
  } finally {
    await file?.close();
  }
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: ultratokenizer-audit --receipt FILE --policy FILE [--strict]\nOffline, EOA-only. Exit 0: no failed checks but incomplete; 1: invalid; 2: strict and incomplete; 64: usage.\n',
    );
    return 0;
  }
  let receiptPath = '';
  let policyPath = '';
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict' && !strict) strict = true;
    else if (
      args[i] === '--receipt' &&
      !receiptPath &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      receiptPath = args[++i];
    else if (
      args[i] === '--policy' &&
      !policyPath &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      policyPath = args[++i];
    else {
      process.stderr.write('Invalid arguments. Use --help.\n');
      return 64;
    }
  }
  if (!receiptPath || !policyPath) {
    process.stderr.write(
      'Receipt and separate policy files are required. Use --help.\n',
    );
    return 64;
  }
  try {
    const receipt = await boundedFile(receiptPath, MAX_RECEIPT_BYTES);
    const policy = parseAuditPolicy(
      await boundedFile(policyPath, MAX_POLICY_BYTES),
    );
    const report = await auditIssuanceReceipt(receipt, policy);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'invalid' ? 1 : strict ? 2 : 0;
  } catch (cause) {
    const error =
      cause instanceof AuditInputError
        ? cause
        : new AuditInputError('invalid_receipt');
    process.stdout.write(
      `${JSON.stringify(
        {
          format: 'ultratokenizer.audit-report.v1',
          status: 'invalid',
          complete: false,
          error: { code: error.code, message: error.message },
          checks: [
            { id: 'input_schema', status: 'failed', detail: error.message },
          ],
          missingEvidence: ['audit_not_completed'],
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}
process.exitCode = await main(process.argv.slice(2));
