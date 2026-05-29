/**
 * `@blockchain0x/x402` - HTTP-402 protocol primitives for autonomous
 * agents on Base + USDC.
 *
 * Three entry points:
 *
 *   import { parse402Response, buildPaymentHeader, parsePaymentHeader }
 *     from '@blockchain0x/x402';                              // wire
 *
 *   import { createX402Client } from '@blockchain0x/x402/client';
 *   import { createX402Plugin } from '@blockchain0x/x402/server/fastify';
 *   import { createX402Middleware } from '@blockchain0x/x402/server/express';
 *
 * The `@blockchain0x/node` SDK is a hard peer dependency: the client
 * wrapper calls `sdk.payments.create` + `sdk.transactions.get`, and the
 * server adapters call `sdk.paymentRequests.settle`. Trust model: the
 * server adapter is a thin verification shim; the canonical settlement
 * trust gate lives in the Blockchain0x backend.
 */

// Wire-format primitives are the default export so the most common
// import shape (`from '@blockchain0x/x402'`) gets them without a
// subpath.
export { parse402Response, buildPaymentHeader, parsePaymentHeader, X402WireError } from './wire.js';

export type { ExactUsdcPayment, Network, PaymentRequirement, X402Response } from './types.js';
