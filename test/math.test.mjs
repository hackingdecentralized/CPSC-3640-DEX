import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TICK, MIN_TICK, Q96, applyBps, deviationPpb, encodeSqrtPriceX96, formatRational, fullRangeTicks,
  priceMoveInput, sortTokens, sqrtBigInt, targetRawRatio, tokenPerQuoteFromSqrtPrice,
} from '../scripts/lib/math.mjs';

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const TOKEN = '0xBc2BEfb9a8aA70AfA23F7451A0794466976B6974';
const TARGET = { num: 20000n, den: 1n };

test('sqrtBigInt is an exact floor sqrt', () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, (1n << 200n) - 1n]) {
    const r = sqrtBigInt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `n=${n}`);
  }
});

test('sortTokens orders by numeric address value', () => {
  assert.deepEqual(sortTokens(TOKEN, USDC), [USDC, TOKEN]);
  assert.deepEqual(sortTokens(USDC, TOKEN), [USDC, TOKEN]);
  assert.throws(() => sortTokens(USDC, USDC));
});

test('Sepolia pair: USDC(6) is token0, TOKEN(18) is token1 -> 20,000 TOKEN/USDC', () => {
  const dec = { quoteIsToken0: true, quoteDecimals: 6, tokenDecimals: 18 };
  const { amount0, amount1 } = targetRawRatio({ ...dec, target: TARGET });
  assert.equal(amount0, 10n ** 6n);
  assert.equal(amount1, 20000n * 10n ** 18n);
  const sqrtP = encodeSqrtPriceX96(amount1, amount0);
  // sqrt(2e16) * 2^96 = 141421356.237... * 2^96
  assert.equal(sqrtP, sqrtBigInt(2n * 10n ** 16n * (1n << 192n)));
  assert.ok(sqrtP / Q96 === 141421356n);
  const price = tokenPerQuoteFromSqrtPrice(sqrtP, dec);
  assert.equal(formatRational(price, 6), '20000.0');
  assert.ok(deviationPpb(price, TARGET) < 1n); // flooring error is far below 1 ppb
});

test('price math is symmetric when USDC is token1', () => {
  for (const [ud, td] of [[6, 18], [6, 6], [18, 8]]) {
    const dec = { quoteIsToken0: false, quoteDecimals: ud, tokenDecimals: td };
    const { amount0, amount1 } = targetRawRatio({ ...dec, target: TARGET });
    assert.equal(amount0, 20000n * 10n ** BigInt(td)); // token0 is TOKEN
    assert.equal(amount1, 10n ** BigInt(ud));
    const price = tokenPerQuoteFromSqrtPrice(encodeSqrtPriceX96(amount1, amount0), dec);
    assert.ok(deviationPpb(price, TARGET) < 1000n, `ud=${ud} td=${td}`);
  }
});

test('deviationPpb detects >1% mismatch', () => {
  assert.equal(deviationPpb({ num: 20200n, den: 1n }, TARGET), 10_000_000n); // exactly 1%
  assert.ok(deviationPpb({ num: 20201n, den: 1n }, TARGET) > 10_000_000n);
  assert.ok(deviationPpb({ num: 19799n, den: 1n }, TARGET) > 10_000_000n);
  assert.equal(deviationPpb({ num: 40000n, den: 2n }, TARGET), 0n);
});

test('fullRangeTicks are spacing multiples inside [MIN_TICK, MAX_TICK]', () => {
  const expected = { 1: [-887272, 887272], 10: [-887270, 887270], 60: [-887220, 887220], 200: [-887200, 887200] };
  for (const [spacing, [lo, hi]] of Object.entries(expected)) {
    const { tickLower, tickUpper } = fullRangeTicks(Number(spacing));
    assert.deepEqual([tickLower, tickUpper], [lo, hi]);
    assert.equal(tickLower % Number(spacing), -0);
    assert.ok(tickLower >= MIN_TICK && tickUpper <= MAX_TICK);
    assert.ok(tickLower - Number(spacing) < MIN_TICK && tickUpper + Number(spacing) > MAX_TICK);
  }
  assert.throws(() => fullRangeTicks(0));
});

test('applyBps', () => {
  assert.equal(applyBps(50_000_000n, 200n), 49_000_000n);
});

test('1:10 target encodes and decodes exactly', () => {
  const dec = { quoteIsToken0: true, quoteDecimals: 6, tokenDecimals: 18 };
  const { amount0, amount1 } = targetRawRatio({ ...dec, target: { num: 10n, den: 1n } });
  const sqrtP = encodeSqrtPriceX96(amount1, amount0);
  assert.equal(sqrtP, sqrtBigInt(10n ** 13n * (1n << 192n)));
  assert.equal(formatRational(tokenPerQuoteFromSqrtPrice(sqrtP, dec), 6), '10.0');
});

test('priceMoveInput matches constant-product intuition for the 20,000 -> 10 move', () => {
  const dec = { quoteIsToken0: true, quoteDecimals: 6, tokenDecimals: 18 };
  const at = (num) => {
    const r = targetRawRatio({ ...dec, target: { num, den: 1n } });
    return encodeSqrtPriceX96(r.amount1, r.amount0);
  };
  const L = 7071067811865475n; // the deployed 50 USDC + 1,000,000 TOKEN full-range position
  const { zeroForOne, amountIn } = priceMoveInput(L, at(20000n), at(10n), 0);
  assert.equal(zeroForOne, true); // USDC (token0) in pushes TOKEN-per-USDC down
  // x*y=k: 50 USDC * 1,000,000 TOKEN at y/x = 10 -> x = sqrt(5e6) = 2236.07 USDC, so ~2186.07 USDC in
  assert.ok(amountIn > 2186_000000n && amountIn < 2186_200000n, `${amountIn}`);
  // linear in liquidity, fee grossed up, direction flips
  assert.ok(priceMoveInput(L / 1_000_000n, at(20000n), at(10n), 0).amountIn <= amountIn / 1_000_000n + 1n);
  assert.ok(priceMoveInput(L, at(20000n), at(10n), 10000).amountIn > amountIn);
  assert.equal(priceMoveInput(L, at(10n), at(20000n), 0).zeroForOne, false);
});

test('WETH pair: TOKEN is token0, WETH token1 -> 10,000 TOKEN per WETH', () => {
  const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
  assert.deepEqual(sortTokens(WETH, TOKEN), [TOKEN, WETH]);
  const dec = { quoteIsToken0: false, quoteDecimals: 18, tokenDecimals: 18 };
  const { amount0, amount1 } = targetRawRatio({ ...dec, target: { num: 10000n, den: 1n } });
  assert.equal(amount0, 10000n * 10n ** 18n); // TOKEN
  assert.equal(amount1, 10n ** 18n); // WETH
  const sqrtP = encodeSqrtPriceX96(amount1, amount0);
  assert.equal(sqrtP, Q96 / 100n); // sqrt(1e-4) = 0.01
  assert.equal(formatRational(tokenPerQuoteFromSqrtPrice(sqrtP, dec), 6), '10000.0');
});
