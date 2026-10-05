// Uniswap V3 price/tick math in exact BigInt arithmetic. Prices are carried as rationals {num, den}
// so nothing is rounded until it is formatted for display.
import { formatUnits } from 'ethers';

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** floor(sqrt(n)) for a non-negative BigInt (Newton's method). */
export function sqrtBigInt(n) {
  if (n < 0n) throw new RangeError('sqrt of negative number');
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  let y = (x + n / x) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** Uniswap orders a pair by numeric address value. */
export function sortTokens(a, b) {
  const ai = BigInt(a);
  const bi = BigInt(b);
  if (ai === bi) throw new Error('token addresses are identical');
  return ai < bi ? [a, b] : [b, a];
}

/**
 * Raw token0/token1 amounts that express the target human price, honouring actual
 * token ordering and decimals. `target` is TOKEN-per-quote-token as {num, den}:
 * `den` quote tokens trade for `num` TOKEN.
 */
export function targetRawRatio({ quoteIsToken0, quoteDecimals, tokenDecimals, target }) {
  const quoteRaw = target.den * 10n ** BigInt(quoteDecimals);
  const tokenRaw = target.num * 10n ** BigInt(tokenDecimals);
  return quoteIsToken0 ? { amount0: quoteRaw, amount1: tokenRaw } : { amount0: tokenRaw, amount1: quoteRaw };
}

/** sqrtPriceX96 = floor(sqrt(amount1 / amount0) * 2^96), computed exactly. */
export function encodeSqrtPriceX96(amount1, amount0) {
  if (amount0 <= 0n || amount1 <= 0n) throw new RangeError('amounts must be positive');
  // floor(sqrt(floor(x))) == floor(sqrt(x)) for real x >= 0, so this is exact.
  const sqrtPriceX96 = sqrtBigInt((amount1 << 192n) / amount0);
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new RangeError(`sqrtPriceX96 ${sqrtPriceX96} outside Uniswap V3 bounds`);
  }
  return sqrtPriceX96;
}

/** Pool sqrtPriceX96 -> TOKEN per quote token (human units) as an exact rational. */
export function tokenPerQuoteFromSqrtPrice(sqrtPriceX96, { quoteIsToken0, quoteDecimals, tokenDecimals }) {
  // price(token1/token0) in raw units = sqrtPriceX96^2 / 2^192
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  const ud = 10n ** BigInt(quoteDecimals);
  const td = 10n ** BigInt(tokenDecimals);
  return quoteIsToken0
    ? { num: p2 * ud, den: Q192 * td } //  TOKEN raw per quote raw  -> rescale
    : { num: Q192 * ud, den: p2 * td }; // quote raw per TOKEN raw  -> invert, rescale
}

/** |current - target| / target, in parts per billion (1% = 10,000,000). */
export function deviationPpb(current, target) {
  let diff = current.num * target.den - target.num * current.den;
  if (diff < 0n) diff = -diff;
  return (diff * 1_000_000_000n) / (target.num * current.den);
}

export function formatPpbAsPercent(ppb) {
  return `${formatUnits(ppb, 7)}%`;
}

/** Decimal string rounded half-up to `decimals` places. */
export function formatRational({ num, den }, decimals = 8) {
  return formatUnits((2n * num * 10n ** BigInt(decimals) + den) / (2n * den), decimals);
}

/** Widest tick range whose bounds are exact multiples of `tickSpacing`. */
export function fullRangeTicks(tickSpacing) {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new RangeError(`invalid tickSpacing ${tickSpacing}`);
  }
  const tickLower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Input (including the LP fee, rounded up) a swap needs to move a pool with active liquidity `liquidity`
 * from sqrtCurrentX96 to sqrtTargetX96, assuming no initialized tick lies in between.
 */
export function priceMoveInput(liquidity, sqrtCurrentX96, sqrtTargetX96, fee) {
  const zeroForOne = sqrtTargetX96 < sqrtCurrentX96;
  const amount = zeroForOne
    ? ceilDiv(liquidity * (sqrtCurrentX96 - sqrtTargetX96) * Q96, sqrtCurrentX96 * sqrtTargetX96) // token0 in
    : ceilDiv(liquidity * (sqrtTargetX96 - sqrtCurrentX96), Q96); // token1 in
  return { zeroForOne, amountIn: ceilDiv(amount * 1_000_000n, 1_000_000n - BigInt(fee)) };
}

export function applyBps(amount, bpsOff) {
  return (amount * (10_000n - bpsOff)) / 10_000n;
}
