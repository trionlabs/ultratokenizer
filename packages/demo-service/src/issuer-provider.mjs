import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { getAddress, encodeFunctionData, hashTypedData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getIssuanceRequestDigest,
  getIssuerPermitTypedData,
  parseIssuerPermit,
  parseDuplicateFreeJson,
} from '../../../dist/domain/src/index.js';
import { ISSUANCE_GATE_ABI } from '../../issuance/dist/index.js';
import {
  check,
  readOwned,
  writeNew,
  optionalJson,
  ServiceError,
} from './io.mjs';

export async function credential(root, source) {
  check(
    source &&
      typeof source.path === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(source.variable),
    'operations_disabled',
  );
  const values = parseEnv(
    (await readOwned(resolve(root, source.path), 64 * 1024)).toString('utf8'),
  );
  let value = values[source.variable];
  check(typeof value === 'string', 'operations_disabled');
  if (!value.startsWith('0x')) value = `0x${value}`;
  check(/^0x[0-9a-fA-F]{64}$/.test(value), 'operations_disabled');
  return value;
}

/** Actual narrow EIP-1193 issuer adapter: one reservation or one permit per instance. */
export function issuerProvider(runtime, job, folder, { permitNonce } = {}) {
  const { policy, reader } = runtime;
  let attempted = false;
  return {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x128';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts')
        return [policy.issuerAddress];
      await runtime.assertOperationsEnabled();
      check(!attempted, 'reservation_uncertain');
      if (method === 'eth_signTypedData_v4' && permitNonce) {
        check(
          Array.isArray(params) &&
            params.length === 2 &&
            getAddress(params[0]) === policy.issuerAddress,
          'issuer_unavailable',
        );
        check(
          typeof params[1] === 'string' &&
            Buffer.byteLength(params[1]) <= 16 * 1024,
          'issuer_unavailable',
        );
        const payload = parseDuplicateFreeJson(params[1], 16 * 1024);
        const permit = parseIssuerPermit(payload.message);
        check(
          permit.nonce === permitNonce &&
            permit.keyVersion === policy.issuerKeyVersion,
          'issuer_unavailable',
        );
        const exact = getIssuerPermitTypedData(job.request, permit);
        // EIP-1193 serializes bigint chain IDs as strings; normalize before hashing.
        check(
          hashTypedData({
            ...payload,
            domain: {
              ...payload.domain,
              chainId: BigInt(payload.domain.chainId),
            },
          }) === hashTypedData(exact),
          'issuer_unavailable',
        );
        attempted = true;
        await writeNew(join(folder, `permit-${permitNonce}.intent.json`), {
          requestDigest: job.requestDigest,
          permit,
        });
        const account = privateKeyToAccount(
          await credential(runtime.root, runtime.config.issuerCredential),
        );
        check(account.address === policy.issuerAddress, 'issuer_unavailable');
        return account.signTypedData(exact);
      }
      check(
        method === 'eth_sendTransaction' &&
          !permitNonce &&
          Array.isArray(params) &&
          params.length === 1,
        'issuer_unavailable',
      );
      const transaction = params[0];
      const request = job.request;
      const data = encodeFunctionData({
        abi: ISSUANCE_GATE_ABI,
        functionName: 'openReservation',
        args: [
          request.issuerId,
          BigInt(policy.issuerKeyVersion),
          request.reservationId,
          request.recipient,
          request.token,
          BigInt(request.amount),
          BigInt(request.validUntil),
          getIssuanceRequestDigest(request),
          request.claimUsageId,
        ],
      });
      check(
        getAddress(transaction.from) === policy.issuerAddress &&
          getAddress(transaction.to) === policy.gate &&
          transaction.data === data &&
          BigInt(transaction.value ?? '0x0') === 0n,
        'issuer_unavailable',
      );
      check((await reader.getChainId()) === 296, 'deployment_unavailable');
      const previous = await optionalJson(
        join(folder, 'reservation-send.intent.json'),
      );
      if (previous) throw new ServiceError('reservation_uncertain');
      const nonce = await reader.getTransactionCount({
        address: policy.issuerAddress,
        blockTag: 'pending',
      });
      const estimate = await reader.estimateGas({
        account: policy.issuerAddress,
        to: policy.gate,
        data,
        value: 0n,
      });
      const gas = (estimate * 125n) / 100n + 25000n;
      const price = (await reader.getGasPrice()) * 2n;
      check(
        gas * price <=
          BigInt(runtime.config.maxReservationFeeTinybar) * 10_000_000_000n,
        'issuer_unavailable',
      );
      const account = privateKeyToAccount(
        await credential(runtime.root, runtime.config.issuerCredential),
      );
      check(account.address === policy.issuerAddress, 'issuer_unavailable');
      attempted = true;
      // Intent exists even if signing fails; a restart never signs a replacement.
      await writeNew(join(folder, 'reservation-send.intent.json'), {
        requestDigest: job.requestDigest,
        nonce,
        from: policy.issuerAddress,
        to: policy.gate,
        data,
        gas: String(gas),
        maxFeePerGas: String(price),
        signingAttempted: true,
      });
      const raw = await account.signTransaction({
        type: 'eip1559',
        chainId: 296,
        nonce,
        to: policy.gate,
        data,
        value: 0n,
        gas,
        maxFeePerGas: price,
        maxPriorityFeePerGas: 0n,
      });
      const expectedHash = keccak256(raw);
      await writeNew(join(folder, 'reservation-send.signed.json'), {
        raw,
        expectedHash,
      });
      await writeNew(join(folder, 'reservation-send.dispatch.json'), {
        expectedHash,
        attemptedAt: new Date().toISOString(),
      });
      try {
        const actual = await reader.sendRawTransaction({
          serializedTransaction: raw,
        });
        check(actual === expectedHash, 'reservation_uncertain');
        return actual;
      } catch {
        throw new ServiceError('reservation_uncertain');
      }
    },
  };
}
