/**
 * Shared types for the x402 client + server adapters.
 *
 * The wire format follows Coinbase's x402 reference (HTTP 402 + an
 * `X-Payment` header) constrained to USDC on Base. Network and amount
 * are part of the requirement; the server adapter resolves them against
 * the configured pricing table.
 */

export type Network = 'mainnet' | 'testnet';

/**
 * A single payment requirement surfaced in a 402 response body. A
 * resource may quote multiple requirements (e.g. USDC on mainnet OR
 * testnet); the client picks the one that matches its API-key mode.
 */
export interface PaymentRequirement {
  /**
   * Payment scheme identifier. Currently always `"exact-usdc"` for the
   * Blockchain0x x402 implementation - the payer transfers exactly the
   * stated amount in USDC to `payToAddress`.
   */
  scheme: 'exact-usdc';
  /** Network the chain transfer must happen on. */
  network: Network;
  /** CAIP-2 chain id (`eip155:8453` mainnet, `eip155:84532` testnet). */
  chainId: string;
  /** Address the funds must land on. */
  payToAddress: string;
  /** Amount in 6-dp USDC base units (text-encoded uint - matches `amount_wei` on the wire). */
  amountWeiUsdc: string;
  /** Server-side invoice id the client passes back in X-Payment so settle can resolve it. */
  paymentRequestId: string;
  /** Maximum seconds between requirement issue and on-chain confirmation. Default 60. */
  maxAgeSeconds?: number;
}

/**
 * The body of a 402 response. Mirrors the Coinbase x402 reference layout:
 * a top-level `version`, the resource being protected, and an array of
 * `accepts` requirements the client can choose from.
 */
export interface X402Response {
  version: 1;
  resource: string;
  accepts: readonly PaymentRequirement[];
}

/**
 * Decoded X-Payment header payload. The header's wire form is
 * `<scheme>:<base64-payload>`. For `exact-usdc` the payload is the JSON
 * shape below, base64-encoded.
 */
export interface ExactUsdcPayment {
  scheme: 'exact-usdc';
  version: 1;
  /** The same id from the 402 requirement - the server uses it to look up the invoice. */
  paymentRequestId: string;
  /** 0x-prefixed 32-byte transaction hash, lowercased. */
  txHash: string;
  /** 0x-prefixed 20-byte address that funded the transfer, lowercased. */
  payerAddress: string;
  /** Human USDC decimal the payer sent (matches the server's amountUsdcVerified). */
  amountUsdc: string;
  /** Network the transfer happened on - validated against the API-key mode server-side. */
  network: Network;
}
