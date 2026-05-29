/**
 * Shared logic for the Fastify + Express x402 server adapters.
 *
 * Pricing table: a static map from `<METHOD> <path>` to `{ amountUsdc,
 * payToAddress, paymentRequestId }`. The adapters look up the incoming
 * request against this table; a hit means a 402 must be issued (unless
 * a valid X-Payment is attached). A miss means the route is free - the
 * adapter is a no-op.
 *
 * Why static? The plan keeps the pricing surface small and inspectable:
 * the operator declares it once at boot, the adapter doesn't reach into
 * the database mid-request. Dynamic pricing (per-caller, per-resource)
 * can layer on top later by passing a function instead of a literal.
 */

import { parsePaymentHeader, X402WireError } from '../wire.js';
import type { ExactUsdcPayment, Network, PaymentRequirement, X402Response } from '../types.js';

/**
 * Per-route price quote. The adapter assembles `accepts[]` from one or
 * more of these - typically just the one matching the configured server
 * network, but operators may quote both networks during a migration.
 */
export interface PricingEntry {
  amountUsdc: string;
  payToAddress: string;
  paymentRequestId: string;
  network?: Network;
}

export type PricingTable = Readonly<Record<string, PricingEntry>>;

/**
 * The minimum SDK surface the server adapter calls. Mirrors the
 * `paymentRequests.settle` shape so a mock can substitute it in tests
 * without pulling in the full `Blockchain0xClient`.
 */
export interface X402ServerSdkLike {
  paymentRequests: {
    settle(args: {
      paymentRequestId: string;
      body: {
        txHash: string;
        payerAddress: string;
        amountUsdcVerified: string;
      };
    }): Promise<{ id: string; status: 'settled'; settledTxHash: string; settledAt: string }>;
  };
}

export interface AdapterOptions {
  sdk: X402ServerSdkLike;
  pricing: PricingTable;
  /**
   * Default network for the issued requirement when the pricing entry
   * doesn't pin one. Defaults to mainnet.
   */
  defaultNetwork?: Network;
  /**
   * Maximum age (seconds) a chain confirmation may be when the agent
   * presents it. Forwarded as `maxAgeSeconds` on the requirement so the
   * payer's wrapper knows the window the server will honour.
   */
  maxAgeSeconds?: number;
}

const CAIP2_BY_NETWORK: Record<Network, string> = {
  mainnet: 'eip155:8453',
  testnet: 'eip155:84532',
};

function usdcDecimalToWei(decimal: string): string {
  const [whole, frac = ''] = decimal.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const wei = BigInt(whole ?? '0') * 1_000_000n + BigInt(fracPadded || '0');
  return wei.toString();
}

export function buildRequirement(entry: PricingEntry, defaultNetwork: Network): PaymentRequirement {
  const network: Network = entry.network ?? defaultNetwork;
  return {
    scheme: 'exact-usdc',
    network,
    chainId: CAIP2_BY_NETWORK[network],
    payToAddress: entry.payToAddress,
    amountWeiUsdc: usdcDecimalToWei(entry.amountUsdc),
    paymentRequestId: entry.paymentRequestId,
  };
}

export function build402Body(args: {
  entry: PricingEntry;
  resource: string;
  defaultNetwork: Network;
  maxAgeSeconds: number;
}): X402Response {
  const req = buildRequirement(args.entry, args.defaultNetwork);
  return {
    version: 1,
    resource: args.resource,
    accepts: [{ ...req, maxAgeSeconds: args.maxAgeSeconds }],
  };
}

export type VerifyOutcome =
  | { ok: true; payment: ExactUsdcPayment }
  | {
      ok: false;
      reason: 'header_missing' | 'header_malformed' | 'requirement_mismatch' | 'settle_rejected';
      message: string;
    };

/**
 * Verify an X-Payment header against an expected pricing entry by
 * calling `paymentRequests.settle`. Returns a discriminated union so
 * the adapter can map each branch to the right HTTP response.
 */
export async function verifyXPayment(args: {
  sdk: X402ServerSdkLike;
  header: string | undefined;
  entry: PricingEntry;
}): Promise<VerifyOutcome> {
  if (!args.header) {
    return { ok: false, reason: 'header_missing', message: 'X-Payment header is required.' };
  }
  let payment: ExactUsdcPayment;
  try {
    payment = parsePaymentHeader(args.header);
  } catch (err) {
    return {
      ok: false,
      reason: 'header_malformed',
      message: err instanceof X402WireError ? err.message : 'X-Payment header is malformed.',
    };
  }
  if (payment.paymentRequestId !== args.entry.paymentRequestId) {
    return {
      ok: false,
      reason: 'requirement_mismatch',
      message: `X-Payment references ${payment.paymentRequestId}, route quoted ${args.entry.paymentRequestId}.`,
    };
  }
  try {
    await args.sdk.paymentRequests.settle({
      paymentRequestId: payment.paymentRequestId,
      body: {
        txHash: payment.txHash,
        payerAddress: payment.payerAddress,
        amountUsdcVerified: payment.amountUsdc,
      },
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'settle_rejected',
      message: err instanceof Error ? err.message : 'settle() rejected the proof.',
    };
  }
  return { ok: true, payment };
}

export function pricingKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
