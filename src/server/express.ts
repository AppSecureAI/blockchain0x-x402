/**
 * Express middleware for x402 (sub-plan 21.2 row B-4).
 *
 *   app.use(createX402Middleware({
 *     sdk,
 *     pricing: { 'POST /llm-query': { amountUsdc: '0.10', payToAddress: '0x...', paymentRequestId: 'pr_...' } },
 *   }));
 *
 * Routes that don't appear in `pricing` are unaffected. Routes that do
 * either short-circuit with 402 (no/invalid X-Payment) or call `next()`
 * after stamping `req.x402Payment` with the verified payment.
 *
 * The lookup key is `<METHOD> <originalUrl-without-query>`. Express
 * doesn't expose a parameterised router path on the request until a
 * later middleware in the chain (after `Router` resolution), so we use
 * the literal URL. Operators with parameterised routes can register
 * the same `paymentRequestId` under each concrete path they want to
 * gate, or wrap the middleware on a per-route basis (`router.post('/x',
 * createX402Middleware(...), handler)`).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  build402Body,
  pricingKey,
  verifyXPayment,
  type AdapterOptions,
  type PricingEntry,
} from './shared.js';
import type { ExactUsdcPayment } from '../types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by the x402 middleware when the route required payment AND
       * the `X-Payment` header verified.
       */
      x402Payment?: ExactUsdcPayment;
    }
  }
}

export function createX402Middleware(opts: AdapterOptions): RequestHandler {
  const defaultNetwork = opts.defaultNetwork ?? 'mainnet';
  const maxAgeSeconds = opts.maxAgeSeconds ?? 60;

  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Express path. Use req.path (URL minus query). For router-mounted
    // middleware, `req.baseUrl + req.path` reconstructs the absolute path.
    const path = (req.baseUrl ?? '') + req.path;
    const key = pricingKey(req.method, path);
    const entry: PricingEntry | undefined = opts.pricing[key];
    if (!entry) {
      next();
      return;
    }

    const headerRaw = req.header('X-Payment');
    const outcome = await verifyXPayment({
      sdk: opts.sdk,
      header: headerRaw,
      entry,
    });

    if (!outcome.ok) {
      const body = build402Body({
        entry,
        resource: `${req.method} ${path}`,
        defaultNetwork,
        maxAgeSeconds,
      });
      res.status(402).json({
        ...body,
        error: { reason: outcome.reason, message: outcome.message },
      });
      return;
    }

    req.x402Payment = outcome.payment;
    next();
  };
}

export default createX402Middleware;
