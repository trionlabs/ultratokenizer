import { resolveEnsRecipient as resolveSharedEnsRecipient } from '../../../../packages/issuance/src/index.js';
import { parseBrowserRpcUrl } from './browser-rpc';

export {
  createIssuanceClient,
  parseDeploymentConfig,
  getTokenBackend,
  parseIssuanceBundle,
  parseTransactionHash,
  assertBundleDeployment,
  IssuanceClientError,
  MAX_BUNDLE_BYTES,
  MAX_DEPLOYMENT_BYTES,
} from '../../../../packages/issuance/src/index.js';
export type {
  IssuanceClient,
  IssuanceBundle,
  DeploymentConfig,
  ConnectedWallet,
  TokenTransactionIntent,
} from '../../../../packages/issuance/src/index.js';
export type { IssuanceReceipt } from '../../../../packages/audit/src/index.js';

export async function resolveEnsRecipient(
  input: Parameters<typeof resolveSharedEnsRecipient>[0],
) {
  return resolveSharedEnsRecipient({
    ...input,
    ethereumRpcUrl: parseBrowserRpcUrl(input.ethereumRpcUrl),
  });
}

export function formatGrams(milligrams: string | bigint): string {
  const value = BigInt(milligrams);
  return `${value / 1000n}.${(value % 1000n).toString().padStart(3, '0')}`;
}

/** Transfer quantities can divide an issued right; issuance itself has no amount editor. */
export function parseTransferGrams(value: string): string {
  if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,3})?$/.test(value))
    throw new Error(
      'Enter a positive amount in grams, with at most three decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  const milligrams = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (milligrams <= 0n || milligrams > 9223372036854775807n)
    throw new Error(
      'The transfer amount is outside the supported milligram range.',
    );
  return milligrams.toString();
}

export async function readJsonFile(file: File, limit: number): Promise<string> {
  if (file.size > limit)
    throw new Error(`Choose a JSON file no larger than ${limit / 1024} KB.`);
  const text = await file.text();
  if (text.length > limit || new TextEncoder().encode(text).length > limit)
    throw new Error(`Choose a JSON file no larger than ${limit / 1024} KB.`);
  return text;
}

export function saveJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(value, null, 2)}\n`], {
      type: 'application/json',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
