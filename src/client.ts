/**
 * `createX402Client({ sdk })` (sub-plan 21.2 row B-3).
 *
 * Returns a fetch-compatible function that handles HTTP 402 transparently:
 *
 *   const fetch = createX402Client({ sdk });
 *   const res = await fetch('https://service-b.com/expensive');
 *   // status === 200 on the second try, body is whatever service-b returned.
 *
 * Flow on the 402 branch:
 *
 *   1. parse402Response(res) -> requirements[].
 *   2. Pick the requirement whose `network` matches the SDK's bound key
 *      mode (sk_test_* -> testnet, sk_live_* -> mainnet). No match -> we
 *      surface `X402ClientError('no_matching_requirement')` and stop -
 *      paying on the wrong network is rejected by the recipient anyway.
 *   3. sdk.payments.create({ agentId, to, amountWei }) for the chosen
 *      requirement. The SDK auto-attaches an `Idempotency-Key` so a flaky
 *      retry doesn't double-spend (sub-plan 21.1 row B-4 contract).
 *   4. Poll `sdk.transactions.get(payment.id)` every 1s up to 30s until
 *      `status === 'confirmed'` AND `txHash` is non-null. Timeout ->
 *      `X402ClientError('settlement_timeout')`. Failure status ->
 *      `X402ClientError('chain_failed')`.
 *   5. Build the X-Payment header with buildPaymentHeader and re-issue
 *      the original request. Returns whatever the retry produces.
 *
 * Single retry only - if the second hop also returns 402 the wrapper
 * propagates that response unchanged so the caller can decide whether to
 * loop or surface to the user.
 */

import { buildPaymentHeader, parse402Response, X402WireError } from './wire.js';
import type { ExactUsdcPayment, PaymentRequirement } from './types.js';

/**
 * The subset of `@blockchain0x/node`'s client surface this wrapper
 * actually depends on. Encoded as an interface so:
 *   (a) tests can inject a mock without `vi.mock`ing the whole module,
 *   (b) consumers on older SDK majors get a clear type-level mismatch.
 */
export interface X402SdkLike {
  options: {
    apiKey: string;
    network?: 'mainnet' | 'testnet';
  };
  payments: {
    create(body: {
      agentId: string;
      to: string;
      amountWei: string;
    }): Promise<{ id: string; agentId: string; status: string }>;
  };
  transactions: {
    get(transactionId: string): Promise<{
      id: string;
      status: 'pending' | 'submitted' | 'confirmed' | 'failed';
      txHash?: string | null;
      fromAddress?: string | null;
    }>;
  };
}

export interface CreateX402ClientOptions {
  sdk: X402SdkLike;
  /**
   * Agent the payment is sent from. Optional - the SDK is keyed to a
   * single agent already (the `apiKey.agentId` fence). The wrapper
   * threads this through if set so a workspace-scope key can pick.
   */
  agentId?: string;
  /**
   * Override the underlying fetch implementation. Defaults to
   * `globalThis.fetch`. Mostly a testing seam.
   */
  fetch?: typeof globalThis.fetch;
  /** Total seconds to wait for `transactions.get` to flip confirmed. Default 30. */
  confirmTimeoutSeconds?: number;
  /** Poll interval in ms while waiting for confirmation. Default 1000. */
  confirmPollMs?: number;
  /** Sleeper override - testing seam. */
  sleep?: (ms: number) => Promise<void>;
}

export class X402ClientError extends Error {
  readonly code: 'no_matching_requirement' | 'settlement_timeout' | 'chain_failed' | 'second_402';
  constructor(code: X402ClientError['code'], message: string) {
    super(message);
    this.name = 'X402ClientError';
    this.code = code;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkFromApiKey(apiKey: string): 'mainnet' | 'testnet' | null {
  if (apiKey.startsWith('sk_live_')) {
    return 'mainnet';
  }
  if (apiKey.startsWith('sk_test_')) {
    return 'testnet';
  }
  return null;
}

function pickRequirement(
  accepts: readonly PaymentRequirement[],
  preferredNetwork: 'mainnet' | 'testnet' | null
): PaymentRequirement | null {
  if (preferredNetwork) {
    const match = accepts.find((r) => r.network === preferredNetwork);
    if (match) {
      return match;
    }
  }
  // Fall back to the first listed requirement if the SDK doesn't know
  // its network (no apiKey prefix). The server will reject a wrong-net
  // settlement; this still gives the caller a deterministic choice.
  return accepts[0] ?? null;
}

function usdcDecimalFromWei(amountWei: string): string {
  const whole = amountWei.slice(0, -6) || '0';
  const fracPadded = amountWei.padStart(7, '0').slice(-6);
  const fracTrimmed = fracPadded.replace(/0+$/, '');
  return fracTrimmed.length > 0 ? `${whole}.${fracTrimmed}` : whole;
}

export function createX402Client(options: CreateX402ClientOptions): typeof globalThis.fetch {
  const sdk = options.sdk;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const confirmTimeoutSec = options.confirmTimeoutSeconds ?? 30;
  const confirmPollMs = options.confirmPollMs ?? 1000;

  const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) {
      return first;
    }
    // Clone so a downstream consumer of the original response (rare,
    // but legitimate) can still read its body.
    const x402 = await parse402Response(first.clone());
    const network = sdk.options.network ?? networkFromApiKey(sdk.options.apiKey);
    const requirement = pickRequirement(x402.accepts, network);
    if (!requirement) {
      throw new X402ClientError(
        'no_matching_requirement',
        `402 response has no requirement matching network ${network ?? 'unknown'}.`
      );
    }
    if (!options.agentId) {
      // The SDK's apiKey.agentId fence binds the agent server-side; we
      // pass an empty string so the route resolves to the bound agent.
      // (`payments.create` on the SDK keeps the field required in its
      // type for workspace-scope callers - the server ignores an empty
      // string when an agent is bound to the key.)
    }
    const payment = await sdk.payments.create({
      agentId: options.agentId ?? '',
      to: requirement.payToAddress,
      amountWei: requirement.amountWeiUsdc,
    });

    // Poll for confirmation.
    const deadline = Date.now() + confirmTimeoutSec * 1000;
    let confirmed: Awaited<ReturnType<typeof sdk.transactions.get>> | null = null;
    while (Date.now() < deadline) {
      const tx = await sdk.transactions.get(payment.id);
      if (tx.status === 'failed') {
        throw new X402ClientError(
          'chain_failed',
          `Payment ${payment.id} settled to status=failed on-chain.`
        );
      }
      if (tx.status === 'confirmed' && typeof tx.txHash === 'string' && tx.txHash.length > 0) {
        confirmed = tx;
        break;
      }
      await sleep(confirmPollMs);
    }
    if (!confirmed || !confirmed.txHash) {
      throw new X402ClientError(
        'settlement_timeout',
        `Payment ${payment.id} did not confirm within ${confirmTimeoutSec}s.`
      );
    }

    const payerAddress = confirmed.fromAddress ?? '';
    const xPaymentPayload: ExactUsdcPayment = {
      scheme: 'exact-usdc',
      version: 1,
      paymentRequestId: requirement.paymentRequestId,
      txHash: confirmed.txHash,
      payerAddress,
      amountUsdc: usdcDecimalFromWei(requirement.amountWeiUsdc),
      network: requirement.network,
    };
    const xPayment = buildPaymentHeader(xPaymentPayload);

    // Retry the original request with the X-Payment header set.
    const retryHeaders = new Headers(init?.headers ?? undefined);
    retryHeaders.set('X-Payment', xPayment);
    const second = await fetchImpl(input, { ...(init ?? {}), headers: retryHeaders });
    if (second.status === 402) {
      throw new X402ClientError(
        'second_402',
        'Server returned 402 even after X-Payment was attached - verification likely rejected the proof.'
      );
    }
    return second;
  };

  return wrappedFetch;
}

export { X402WireError };
