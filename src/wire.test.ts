/**
 * Wire-format primitives unit tests. Round-trip + negative cases for
 * the three exports. No network IO, no SDK.
 */

import { describe, expect, it } from 'vitest';

import { buildPaymentHeader, parse402Response, parsePaymentHeader, X402WireError } from './wire.js';
import type { ExactUsdcPayment, X402Response } from './types.js';

const SAMPLE_PAYMENT: ExactUsdcPayment = {
  scheme: 'exact-usdc',
  version: 1,
  paymentRequestId: 'pr_01HQX5',
  txHash: `0x${'4e2b1f8a9d4c5e7f6a8b9c0d1e2f3a4b'.repeat(2)}`,
  payerAddress: '0xabcdef0123456789abcdef0123456789abcdef01',
  amountUsdc: '0.10',
  network: 'mainnet',
};

const SAMPLE_402: X402Response = {
  version: 1,
  resource: 'POST /llm-query',
  accepts: [
    {
      scheme: 'exact-usdc',
      network: 'mainnet',
      chainId: 'eip155:8453',
      payToAddress: '0x1234567890abcdef1234567890abcdef12345678',
      amountWeiUsdc: '100000',
      paymentRequestId: 'pr_01HQX5',
      maxAgeSeconds: 60,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parse402Response', () => {
  it('returns the parsed body on a well-formed 402', async () => {
    const res = jsonResponse(SAMPLE_402, 402);
    const parsed = await parse402Response(res);
    expect(parsed.version).toBe(1);
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]?.paymentRequestId).toBe('pr_01HQX5');
  });

  it('rejects a non-402 status', async () => {
    const res = jsonResponse(SAMPLE_402, 200);
    await expect(parse402Response(res)).rejects.toMatchObject({
      name: 'X402WireError',
      code: 'response.not_402',
    });
  });

  it('rejects an empty accepts array', async () => {
    const res = jsonResponse({ version: 1, resource: 'GET /', accepts: [] }, 402);
    await expect(parse402Response(res)).rejects.toMatchObject({
      code: 'response.body_malformed',
    });
  });

  it('rejects an unknown scheme', async () => {
    const res = jsonResponse(
      {
        version: 1,
        resource: 'GET /',
        accepts: [{ ...SAMPLE_402.accepts[0], scheme: 'unsupported' }],
      },
      402
    );
    await expect(parse402Response(res)).rejects.toMatchObject({
      code: 'response.body_malformed',
    });
  });
});

describe('buildPaymentHeader + parsePaymentHeader', () => {
  it('round-trips the canonical payload', () => {
    const header = buildPaymentHeader(SAMPLE_PAYMENT);
    expect(header.startsWith('exact-usdc:')).toBe(true);
    const parsed = parsePaymentHeader(header);
    expect(parsed).toEqual(SAMPLE_PAYMENT);
  });

  it('lowercases hex fields', () => {
    const upper: ExactUsdcPayment = {
      ...SAMPLE_PAYMENT,
      txHash: `0x${'4E2B1F8A9D4C5E7F6A8B9C0D1E2F3A4B'.repeat(2)}`,
      payerAddress: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
    };
    const header = buildPaymentHeader(upper);
    const parsed = parsePaymentHeader(header);
    expect(parsed.txHash).toBe(SAMPLE_PAYMENT.txHash);
    expect(parsed.payerAddress).toBe(SAMPLE_PAYMENT.payerAddress);
  });

  it('rejects a missing header', () => {
    expect(() => parsePaymentHeader('')).toThrowError(X402WireError);
  });

  it('rejects an unknown scheme', () => {
    expect(() => parsePaymentHeader('other-scheme:abc')).toThrowError(
      /Unsupported X-Payment scheme/
    );
  });

  it('rejects a malformed base64 payload', () => {
    expect(() => parsePaymentHeader('exact-usdc:!!!!')).toThrowError(X402WireError);
  });

  it('rejects a payload with an invalid txHash shape', () => {
    const bad = btoa(
      JSON.stringify({
        ...SAMPLE_PAYMENT,
        txHash: '0xnothex',
      })
    );
    expect(() => parsePaymentHeader(`exact-usdc:${bad}`)).toThrowError(/shape validation/);
  });

  it('rejects a payload with an invalid network', () => {
    const bad = btoa(JSON.stringify({ ...SAMPLE_PAYMENT, network: 'goerli' }));
    expect(() => parsePaymentHeader(`exact-usdc:${bad}`)).toThrowError(/shape validation/);
  });
});
