/**
 * x402 wire-format primitives (sub-plan 21.2 row B-2).
 *
 * Runtime-agnostic: relies on `fetch` (Web Fetch API) + Web `btoa` /
 * `atob` for base64. Works in Node 18+ and any modern browser without a
 * polyfill.
 *
 * Three exports:
 *
 *   - parse402Response(res): pull the accepts[] from a 402 response body.
 *   - buildPaymentHeader(payment): encode an X-Payment header value.
 *   - parsePaymentHeader(value): decode an X-Payment header back to a
 *     typed payment payload.
 *
 * The wire form follows Coinbase's x402 reference:
 *
 *   X-Payment: <scheme>:<base64(payload)>
 *
 * where `<scheme>` is the same string carried in the 402 requirement's
 * `scheme` field (currently only `exact-usdc`). Anything else is
 * rejected with a typed error so the caller can surface "I do not know
 * this payment scheme" cleanly.
 */

import type { ExactUsdcPayment, PaymentRequirement, X402Response } from './types.js';

export class X402WireError extends Error {
  readonly code:
    | 'response.not_402'
    | 'response.body_missing'
    | 'response.body_malformed'
    | 'header.missing'
    | 'header.malformed'
    | 'header.unknown_scheme'
    | 'header.payload_malformed';
  constructor(code: X402WireError['code'], message: string) {
    super(message);
    this.name = 'X402WireError';
    this.code = code;
  }
}

const VALID_NETWORKS = new Set(['mainnet', 'testnet']);

function isPaymentRequirement(value: unknown): value is PaymentRequirement {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    r.scheme === 'exact-usdc' &&
    typeof r.network === 'string' &&
    VALID_NETWORKS.has(r.network) &&
    typeof r.chainId === 'string' &&
    typeof r.payToAddress === 'string' &&
    typeof r.amountWeiUsdc === 'string' &&
    /^[0-9]+$/.test(r.amountWeiUsdc) &&
    typeof r.paymentRequestId === 'string'
  );
}

/**
 * Read an HTTP 402 response and return the parsed `accepts` list. Throws
 * a typed `X402WireError` on shape problems so the caller can branch.
 *
 * The function consumes the body via `.json()`. The caller MUST NOT have
 * already drained the response body; clone first if you need it twice.
 */
export async function parse402Response(res: Response): Promise<X402Response> {
  if (res.status !== 402) {
    throw new X402WireError('response.not_402', `Expected status 402, got ${res.status}.`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new X402WireError('response.body_malformed', '402 response body is not JSON.');
  }
  if (!body || typeof body !== 'object') {
    throw new X402WireError('response.body_missing', '402 response body is missing or non-object.');
  }
  const b = body as Record<string, unknown>;
  if (b.version !== 1) {
    throw new X402WireError(
      'response.body_malformed',
      `Unsupported x402 version: ${String(b.version)}.`
    );
  }
  if (typeof b.resource !== 'string') {
    throw new X402WireError('response.body_malformed', '402 body missing `resource` string.');
  }
  if (!Array.isArray(b.accepts) || b.accepts.length === 0) {
    throw new X402WireError(
      'response.body_malformed',
      '402 body missing `accepts` array or empty.'
    );
  }
  const accepts: PaymentRequirement[] = [];
  for (const entry of b.accepts) {
    if (!isPaymentRequirement(entry)) {
      throw new X402WireError(
        'response.body_malformed',
        '402 `accepts` entry is not a recognised payment requirement.'
      );
    }
    accepts.push(entry);
  }
  return { version: 1, resource: b.resource, accepts };
}

function encodeBase64(text: string): string {
  // Web btoa works on Latin-1; encode to UTF-8 bytes first via the new
  // Uint8Array roundtrip. Node 18+ has globalThis.btoa.
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return globalThis.btoa(binary);
}

function decodeBase64(b64: string): string {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a payment payload as an `X-Payment` header value. Schemes
 * beyond `exact-usdc` are rejected at the type level - widen the union
 * in `./types.ts` first if you add a new scheme.
 */
export function buildPaymentHeader(payment: ExactUsdcPayment): string {
  if (payment.scheme !== 'exact-usdc') {
    throw new X402WireError(
      'header.unknown_scheme',
      `buildPaymentHeader: unsupported scheme ${String((payment as { scheme: unknown }).scheme)}.`
    );
  }
  const json = JSON.stringify({
    scheme: 'exact-usdc',
    version: payment.version,
    paymentRequestId: payment.paymentRequestId,
    txHash: payment.txHash.toLowerCase(),
    payerAddress: payment.payerAddress.toLowerCase(),
    amountUsdc: payment.amountUsdc,
    network: payment.network,
  });
  return `exact-usdc:${encodeBase64(json)}`;
}

/**
 * Decode an X-Payment header value back to a typed payment payload.
 * Returns the structured shape on success, throws `X402WireError` on
 * any malformed input. Lowercases hex fields so downstream comparisons
 * against on-chain `transactions.tx_hash` / `from_address` are
 * deterministic.
 */
export function parsePaymentHeader(value: string): ExactUsdcPayment {
  if (!value || typeof value !== 'string') {
    throw new X402WireError('header.missing', 'X-Payment header is missing or empty.');
  }
  const sep = value.indexOf(':');
  if (sep < 1 || sep === value.length - 1) {
    throw new X402WireError(
      'header.malformed',
      'X-Payment header must be `<scheme>:<base64-payload>`.'
    );
  }
  const scheme = value.slice(0, sep);
  if (scheme !== 'exact-usdc') {
    throw new X402WireError('header.unknown_scheme', `Unsupported X-Payment scheme: ${scheme}.`);
  }
  const b64 = value.slice(sep + 1);
  let json: string;
  try {
    json = decodeBase64(b64);
  } catch {
    throw new X402WireError('header.payload_malformed', 'X-Payment payload is not valid base64.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new X402WireError('header.payload_malformed', 'X-Payment payload is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new X402WireError('header.payload_malformed', 'X-Payment payload is not an object.');
  }
  const p = parsed as Record<string, unknown>;
  if (
    p.scheme !== 'exact-usdc' ||
    p.version !== 1 ||
    typeof p.paymentRequestId !== 'string' ||
    typeof p.txHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(p.txHash) ||
    typeof p.payerAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(p.payerAddress) ||
    typeof p.amountUsdc !== 'string' ||
    !/^[0-9]+(?:\.[0-9]+)?$/.test(p.amountUsdc) ||
    typeof p.network !== 'string' ||
    !VALID_NETWORKS.has(p.network)
  ) {
    throw new X402WireError(
      'header.payload_malformed',
      'X-Payment payload failed shape validation.'
    );
  }
  return {
    scheme: 'exact-usdc',
    version: 1,
    paymentRequestId: p.paymentRequestId,
    txHash: p.txHash.toLowerCase(),
    payerAddress: p.payerAddress.toLowerCase(),
    amountUsdc: p.amountUsdc,
    network: p.network as 'mainnet' | 'testnet',
  };
}
