import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TICK, MIN_TICK, Q96, applyBps, deviationPpb, encodeSqrtPriceX96, formatRational, fullRangeTicks,
  sortTokens, sqrtBigInt, targetRawRatio, tokenPerUsdcFromSqrtPrice,
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
  const dec = { usdcIsToken0: true, usdcDecimals: 6, tokenDecimals: 18 };
  const { amount0, amount1 } = targetRawRatio({ ...dec, target: TARGET });
  assert.equal(amount0, 10n ** 6n);
  assert.equal(amount1, 20000n * 10n ** 18n);
  const sqrtP = encodeSqrtPriceX96(amount1, amount0);
  // sqrt(2e16) * 2^96 = 141421356.237... * 2^96
  assert.equal(sqrtP, sqrtBigInt(2n * 10n ** 16n * (1n << 192n)));
  assert.ok(sqrtP / Q96 === 141421356n);
  const price = tokenPerUsdcFromSqrtPrice(sqrtP, dec);
  assert.equal(formatRational(price, 6), '20000.0');
  assert.ok(deviationPpb(price, TARGET) < 1n); // flooring error is far below 1 ppb
});

test('price math is symmetric when USDC is token1', () => {
  for (const [ud, td] of [[6, 18], [6, 6], [18, 8]]) {
    const dec = { usdcIsToken0: false, usdcDecimals: ud, tokenDecimals: td };
    const { amount0, amount1 } = targetRawRatio({ ...dec, target: TARGET });
    assert.equal(amount0, 20000n * 10n ** BigInt(td)); // token0 is TOKEN
    assert.equal(amount1, 10n ** BigInt(ud));
    const price = tokenPerUsdcFromSqrtPrice(encodeSqrtPriceX96(amount1, amount0), dec);
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
