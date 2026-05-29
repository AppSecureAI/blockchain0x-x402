# @blockchain0x/x402 changelog

## 0.1.0-alpha.0

First publish (sub-plan 21.2 rows B-1..B-5).

Adds:

- Wire-format primitives: `parse402Response`, `buildPaymentHeader`, `parsePaymentHeader` + `X402WireError` (`@blockchain0x/x402`).
- Client wrapper: `createX402Client({ sdk })` returns a `fetch`-compatible function that auto-pays on 402, polls for confirmation, and retries with `X-Payment` (`@blockchain0x/x402/client`).
- Fastify plugin: `createX402Plugin` gates routes behind a USDC quote, calls `sdk.paymentRequests.settle` to verify, stamps `req.x402Payment` (`@blockchain0x/x402/server/fastify`).
- Express middleware: `createX402Middleware` ditto for Express (`@blockchain0x/x402/server/express`).

Peer dependency: `@blockchain0x/node@^0.2.0`.
