/**
 * Fastify plugin for x402 (sub-plan 21.2 row B-4).
 *
 *   app.register(createX402Plugin, {
 *     sdk,
 *     pricing: { 'POST /llm-query': { amountUsdc: '0.10', payToAddress: '0x...', paymentRequestId: 'pr_...' } },
 *   });
 *
 * On every request the plugin looks up `<METHOD> <routerPath>` in the
 * pricing table. A miss is a no-op. A hit, with no valid X-Payment,
 * short-circuits with 402. A hit with a valid X-Payment lets the
 * handler run and tags `req.x402Payment` with the verified payment.
 *
 * Verification calls `sdk.paymentRequests.settle` once, so the server
 * adapter does not itself touch the chain - the backend's settle route
 * is the trust anchor.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  build402Body,
  pricingKey,
  verifyXPayment,
  type AdapterOptions,
  type PricingEntry,
} from './shared.js';
import type { ExactUsdcPayment } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the x402 plugin when the route required payment AND the
     * `X-Payment` header verified. Routes can use it to log the payer
     * address or attach the chain proof to a downstream audit record.
     */
    x402Payment?: ExactUsdcPayment;
  }
}

export const createX402Plugin: FastifyPluginAsync<AdapterOptions> = async (app, opts) => {
  const defaultNetwork = opts.defaultNetwork ?? 'mainnet';
  const maxAgeSeconds = opts.maxAgeSeconds ?? 60;

  app.addHook('preHandler', async (req, reply) => {
    // Fastify routes carry their router path on `req.routeOptions.url`
    // (the `:param`-templated form). Fall back to req.url with the
    // query stripped for sanity.
    const routePath = req.routeOptions?.url ?? req.url.split('?', 1)[0] ?? req.url;
    const key = pricingKey(req.method, routePath);
    const entry: PricingEntry | undefined = opts.pricing[key];
    if (!entry) {
      return; // Route is free.
    }

    const headerRaw = req.headers['x-payment'];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const outcome = await verifyXPayment({ sdk: opts.sdk, header, entry });

    if (!outcome.ok) {
      const body = build402Body({
        entry,
        resource: `${req.method} ${routePath}`,
        defaultNetwork,
        maxAgeSeconds,
      });
      reply
        .code(402)
        .header('content-type', 'application/json')
        .send({
          ...body,
          error: { reason: outcome.reason, message: outcome.message },
        });
      return reply;
    }

    (req as FastifyRequest).x402Payment = outcome.payment;
    return;
  });
};

export default createX402Plugin;
