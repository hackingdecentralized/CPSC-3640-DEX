#!/usr/bin/env node
// Deploys USDC/TOKEN Uniswap V3 pools on Ethereum Sepolia (one per fee tier), initialised at
// 1 USDC = 20,000 TOKEN, and seeds each with a full-range position of 50 USDC + 1,000,000 TOKEN.
//
// Idempotent: existing pools, positions and allowances are inspected and completed steps skipped.
//
//   node scripts/deploy-pools.mjs --dry-run   read-only checks and plan, sends nothing
//   node scripts/deploy-pools.mjs             deploy
//   node scripts/deploy-pools.mjs --swap      deploy, then also run a tiny real verification swap
//
// PRIVATE_KEY is read only from the environment (or a git-ignored .env) and is never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract, JsonRpcProvider, Network, Wallet, ZeroAddress,
  formatEther, formatUnits, getAddress, parseUnits,
} from 'ethers';

import * as C from './lib/config.mjs';
import {
  ERC20_ABI, FACTORY_ABI, POOL_ABI, POSITION_MANAGER_ABI, QUOTER_V2_ABI, SWAP_ROUTER_02_ABI,
} from './lib/abis.mjs';
import {
  applyBps, deviationPpb, encodeSqrtPriceX96, formatPpbAsPercent, formatRational, fullRangeTicks,
  sortTokens, targetRawRatio, tokenPerUsdcFromSqrtPrice,
} from './lib/math.mjs';
import { describeError, installRedaction, redact, registerSecret } from './lib/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'deployments', 'sepolia-uniswap-v3.json');
const SUMMARY_FILE = path.join(ROOT, 'deployments', 'sepolia-uniswap-v3-summary.md');

const STATUS = {
  SUCCESS: 'SUCCESS',
  ALREADY_DEPLOYED: 'ALREADY_DEPLOYED',
  PRICE_MISMATCH: 'PRICE_MISMATCH',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  FAILED: 'FAILED',
};
// Plan actions that commit liquidity.
const FUNDING_ACTIONS = new Set(['CREATE', 'INITIALIZE', 'MINT']);

/** Stops the whole run (wrong chain, unverified target, out of gas money, stuck tx). */
class DeploymentAbort extends Error {}
/** Ends one pool's workflow with a specific final status. */
class PoolStop extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───────────────────────────── setup ─────────────────────────────

function parseArgs() {
  const known = new Set(['--dry-run', '--swap']);
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) throw new DeploymentAbort(`Unknown argument(s): ${unknown.join(' ')}`);
  return { dryRun: args.includes('--dry-run'), swapTest: args.includes('--swap') };
}

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

async function assertSepolia(provider, when) {
  let chainId;
  try {
    chainId = BigInt(await provider.send('eth_chainId', []));
  } catch (err) {
    throw new DeploymentAbort(`Could not read chain ID ${when}: ${describeError(err)}`);
  }
  if (chainId === 1n) {
    throw new DeploymentAbort(`Connected to Ethereum MAINNET (chainId 1) ${when}. Aborting: this script only runs on Sepolia.`);
  }
  if (chainId !== C.SEPOLIA_CHAIN_ID) {
    throw new DeploymentAbort(`Connected to chainId ${chainId} ${when}, expected ${C.SEPOLIA_CHAIN_ID} (Sepolia). Aborting.`);
  }
}

function loadWallet(provider) {
  const raw = process.env.PRIVATE_KEY;
  // Keep the key out of the environment of anything this process might spawn.
  delete process.env.PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    throw new DeploymentAbort('PRIVATE_KEY is not set. Put it in .env (git-ignored) or export it in your shell.');
  }
  const trimmed = raw.trim();
  registerSecret(trimmed);
  const key = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DeploymentAbort('PRIVATE_KEY is malformed (expected 32 bytes of hex). Its value is not shown.');
  }
  try {
    return new Wallet(key, provider);
  } catch {
    throw new DeploymentAbort('PRIVATE_KEY could not be parsed as a secp256k1 key. Its value is not shown.');
  }
}

async function readTokenInfo(contract, label) {
  const [decimals, symbol] = await Promise.all([contract.decimals(), contract.symbol()]);
  return { label, address: getAddress(await contract.getAddress()), decimals: Number(decimals), symbol };
}

async function verifyContracts(ctx) {
  const named = {
    USDC: C.ADDRESSES.USDC,
    TOKEN: C.ADDRESSES.TOKEN,
    UniswapV3Factory: C.ADDRESSES.FACTORY,
    NonfungiblePositionManager: C.ADDRESSES.POSITION_MANAGER,
    QuoterV2: C.ADDRESSES.QUOTER_V2,
    SwapRouter02: C.ADDRESSES.SWAP_ROUTER_02,
  };
  for (const [name, addr] of Object.entries(named)) {
    if ((await ctx.provider.getCode(addr)) === '0x') throw new DeploymentAbort(`${name} at ${addr} has no code on this chain.`);
  }
  const factory = getAddress(C.ADDRESSES.FACTORY);
  const reported = {
    NonfungiblePositionManager: await ctx.npm.factory(),
    QuoterV2: await ctx.quoter.factory(),
    SwapRouter02: await ctx.router.factory(),
  };
  for (const [name, f] of Object.entries(reported)) {
    if (getAddress(f) !== factory) throw new DeploymentAbort(`${name} reports factory ${f}, expected ${factory}.`);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const fmtUsdc = (ctx, raw) => (raw == null ? '—' : `${formatUnits(raw, ctx.usdcInfo.decimals)} ${ctx.usdcInfo.symbol}`);
const fmtToken = (ctx, raw) => (raw == null ? '—' : `${formatUnits(raw, ctx.tokenInfo.decimals)} ${ctx.tokenInfo.symbol}`);
const feePct = (fee) => `${(fee / 10_000).toFixed(2)}%`;
const txLink = (hash) => `${C.EXPLORER_TX}${hash}`;
const tokenContract = (ctx, addr) => (getAddress(addr) === ctx.usdcInfo.address ? ctx.usdc : ctx.token);
const symbolOf = (ctx, addr) => (getAddress(addr) === ctx.usdcInfo.address ? ctx.usdcInfo.symbol : ctx.tokenInfo.symbol);
const usdcOf = (ctx, a0, a1) => (ctx.usdcIsToken0 ? a0 : a1);
const tokenOf = (ctx, a0, a1) => (ctx.usdcIsToken0 ? a1 : a0);

function newRow(ctx, fee) {
  return {
    fee, tickSpacing: null, tickLower: null, tickUpper: null, pool: null,
    action: 'NONE', status: null, notes: [], error: null,
    sqrtPriceX96: null, tick: null, liquidity: null, currentPrice: null, deviationPpb: null,
    tokenId: null, positionLiquidity: null, deposited0: null, deposited1: null, depositSource: null,
    initTx: null, approvals: [], mintTx: null, swapTx: null, verification: null,
  };
}

async function readPoolState(ctx, poolAddr) {
  const pool = new Contract(poolAddr, POOL_ABI, ctx.provider);
  const [t0, t1, fee, spacing, slot0, liquidity] = await Promise.all([
    pool.token0(), pool.token1(), pool.fee(), pool.tickSpacing(), pool.slot0(), pool.liquidity(),
  ]);
  return {
    token0: getAddress(t0), token1: getAddress(t1), fee: Number(fee), tickSpacing: Number(spacing),
    sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), liquidity,
  };
}

function assertPoolIdentity(ctx, row, ps) {
  const problems = [];
  if (ps.token0 !== ctx.token0 || ps.token1 !== ctx.token1) problems.push(`token pair ${ps.token0}/${ps.token1}`);
  if (ps.fee !== row.fee) problems.push(`fee ${ps.fee}`);
  if (ps.tickSpacing !== row.tickSpacing) problems.push(`tickSpacing ${ps.tickSpacing} (factory says ${row.tickSpacing})`);
  if (problems.length) throw new PoolStop(STATUS.FAILED, `pool ${row.pool} does not match expectations: ${problems.join(', ')}`);
}

function recordPoolState(ctx, row, ps) {
  row.sqrtPriceX96 = ps.sqrtPriceX96;
  row.tick = ps.tick;
  row.liquidity = ps.liquidity;
  if (ps.sqrtPriceX96 > 0n) {
    const price = tokenPerUsdcFromSqrtPrice(ps.sqrtPriceX96, ctx.decimals);
    row.currentPrice = formatRational(price, 6);
    row.deviationPpb = deviationPpb(price, C.TARGET_TOKEN_PER_USDC);
  }
}

function priceMismatchMessage(ctx, row) {
  return `current ${row.currentPrice} ${ctx.tokenInfo.symbol}/USDC vs expected ${ctx.targetPriceLabel}, ` +
    `deviation ${formatPpbAsPercent(row.deviationPpb)} > 1%`;
}

async function walletPositions(ctx) {
  const count = await ctx.npm.balanceOf(ctx.address);
  const positions = [];
  for (let i = 0n; i < count; i++) {
    const tokenId = await ctx.npm.tokenOfOwnerByIndex(ctx.address, i);
    const p = await ctx.npm.positions(tokenId);
    positions.push({
      tokenId, token0: getAddress(p.token0), token1: getAddress(p.token1), fee: Number(p.fee),
      tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity,
    });
  }
  return positions;
}

/** The deployer's largest live full-range position in this pool, if any. */
function findDeployedPosition(ctx, row, positions) {
  const matches = positions
    .filter((p) => p.token0 === ctx.token0 && p.token1 === ctx.token1 && p.fee === row.fee &&
      p.tickLower === row.tickLower && p.tickUpper === row.tickUpper && p.liquidity > 0n)
    .sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  if (matches.length > 1) row.notes.push(`deployer holds ${matches.length} full-range positions here: ${matches.map((m) => m.tokenId).join(', ')}`);
  return matches[0] ?? null;
}

// ───────────────────────────── state file ─────────────────────────────

function loadState(ctx) {
  let file = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      file = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (err) {
      console.warn(`  ! could not parse ${path.relative(ROOT, STATE_FILE)} (${err.message}); starting a fresh record`);
    }
  }
  if (!file || file.chainId !== C.SEPOLIA_CHAIN_ID.toString()) {
    file = { chainId: C.SEPOLIA_CHAIN_ID.toString(), deployers: {} };
  }
  Object.assign(file, {
    usdc: ctx.usdcInfo.address, token: ctx.tokenInfo.address,
    factory: C.ADDRESSES.FACTORY, positionManager: C.ADDRESSES.POSITION_MANAGER,
  });
  file.deployers[ctx.address] ??= { pools: {} };
  return file;
}

function persist(ctx, row) {
  if (ctx.dryRun) return;
  const pools = ctx.state.deployers[ctx.address].pools;
  const str = (v) => (v == null ? null : v.toString());
  pools[row.fee] = {
    fee: row.fee, pool: row.pool, tickSpacing: row.tickSpacing, tickLower: row.tickLower, tickUpper: row.tickUpper,
    status: row.status, initTx: row.initTx, approvals: row.approvals, mintTx: row.mintTx, swapTx: row.swapTx,
    tokenId: str(row.tokenId), deposited0: str(row.deposited0), deposited1: str(row.deposited1),
    depositSource: row.depositSource, verification: row.verification, updatedAt: new Date().toISOString(),
  };
  ctx.state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${redact(ctx.state)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

/** Carry forward tx hashes / deposits recorded by earlier runs for the same pool and position. */
function adoptPriorState(ctx, row) {
  const prior = ctx.state.deployers[ctx.address].pools[row.fee];
  if (!prior || !row.pool || prior.pool !== row.pool) return;
  row.initTx = prior.initTx ?? null;
  if (row.tokenId != null && prior.tokenId === row.tokenId.toString()) {
    row.approvals = prior.approvals ?? [];
    row.mintTx = prior.mintTx ?? null;
    row.swapTx = prior.swapTx ?? null;
    if (prior.depositSource === 'mint receipt' && prior.deposited0 != null) {
      row.deposited0 = BigInt(prior.deposited0);
      row.deposited1 = BigInt(prior.deposited1);
      row.depositSource = 'mint receipt';
    }
  }
}

// ───────────────────────────── transactions ─────────────────────────────

/**
 * The only path that broadcasts. Before signing: chain ID re-check, target allowlist + code check,
 * eth_call simulation, gas estimate and an ETH sufficiency check. Waits for the receipt.
 */
async function sendTx(ctx, { label, contract, method, args }) {
  const populated = await contract.getFunction(method).populateTransaction(...args);
  const target = getAddress(populated.to);
  if (!ctx.allowedTargets.has(target)) throw new DeploymentAbort(`Refusing "${label}": ${target} is not a verified contract.`);

  await assertSepolia(ctx.provider, `before "${label}"`);
  if ((await ctx.provider.getCode(target)) === '0x') throw new DeploymentAbort(`Refusing "${label}": ${target} has no code.`);

  const call = { ...populated, from: ctx.address };
  let simulated = null;
  const rawResult = await ctx.provider.call(call); // throws with the revert reason if it would fail
  try {
    simulated = contract.interface.decodeFunctionResult(method, rawResult);
  } catch {
    // Some tokens return no data from approve(); success is what matters.
  }

  const gasEstimate = await ctx.provider.estimateGas(call);
  const gasLimit = (gasEstimate * C.GAS_LIMIT_BUFFER_PCT) / 100n;
  const feeData = await ctx.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  const maxCost = gasLimit * maxFeePerGas;
  const balance = await ctx.provider.getBalance(ctx.address);
  if (balance < maxCost) {
    throw new DeploymentAbort(`Not enough Sepolia ETH for "${label}": need up to ${formatEther(maxCost)} ETH, have ${formatEther(balance)} ETH.`);
  }

  // Track the nonce locally too: load-balanced RPCs can briefly report a stale pending count.
  const chainNonce = await ctx.provider.getTransactionCount(ctx.address, 'pending');
  const nonce = ctx.nextNonce != null && ctx.nextNonce > chainNonce ? ctx.nextNonce : chainNonce;
  const request = { to: populated.to, data: populated.data, gasLimit, nonce };
  if (feeData.maxFeePerGas != null) {
    request.maxFeePerGas = feeData.maxFeePerGas;
    request.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    request.gasPrice = feeData.gasPrice;
  }

  console.log(`    → ${label} (gas est. ${gasEstimate}, max cost ${formatEther(maxCost)} ETH)`);
  const tx = await ctx.wallet.sendTransaction(request);
  ctx.nextNonce = tx.nonce + 1;
  console.log(`      tx ${tx.hash}`);
  let receipt;
  try {
    receipt = await tx.wait(C.TX_CONFIRMATIONS, C.TX_TIMEOUT_MS);
  } catch (err) {
    if (err?.code === 'TIMEOUT') {
      throw new DeploymentAbort(`Transaction ${tx.hash} ("${label}") was not confirmed within ${C.TX_TIMEOUT_MS / 1000}s. ` +
        'Stopping so later transactions do not queue behind it; re-run once it confirms or drops.');
    }
    throw new Error(`"${label}" reverted on-chain (tx ${tx.hash}): ${describeError(err)}`);
  }
  if (!receipt || receipt.status !== 1) throw new Error(`"${label}" failed on-chain (tx ${tx.hash})`);
  console.log(`      confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  return { hash: tx.hash, receipt, simulated };
}

async function ensureAllowance(ctx, row, tokenAddr, spender, spenderName, required) {
  const token = tokenContract(ctx, tokenAddr);
  const symbol = symbolOf(ctx, tokenAddr);
  const current = await token.allowance(ctx.address, spender);
  if (current >= required) {
    const decimals = getAddress(tokenAddr) === ctx.usdcInfo.address ? ctx.usdcInfo.decimals : ctx.tokenInfo.decimals;
    console.log(`    ✓ ${symbol} allowance for ${spenderName} already sufficient (${formatUnits(current, decimals)})`);
    return;
  }
  const { hash } = await sendTx(ctx, {
    label: `fee ${row.fee}: approve ${symbol} for ${spenderName}`,
    contract: token, method: 'approve', args: [spender, required],
  });
  row.approvals.push({ token: symbol, spender: spenderName, hash });
  persist(ctx, row);
  const after = await token.allowance(ctx.address, spender);
  if (after < required) throw new Error(`${symbol} allowance for ${spenderName} is still ${after} after approval (need ${required})`);
}

// ───────────────────────────── plan ─────────────────────────────

async function planPool(ctx, fee, positions) {
  const row = newRow(ctx, fee);
  try {
    // Never assume tick spacing: a zero result means the fee tier is not enabled.
    const spacing = Number(await ctx.factory.feeAmountTickSpacing(fee));
    if (spacing <= 0) throw new PoolStop(STATUS.FAILED, `fee tier ${fee} is not enabled on the factory`);
    row.tickSpacing = spacing;
    Object.assign(row, fullRangeTicks(spacing));

    const poolAddr = getAddress(await ctx.factory.getPool(ctx.token0, ctx.token1, fee));
    if (poolAddr === ZeroAddress) {
      row.action = 'CREATE';
      return row;
    }
    row.pool = poolAddr;
    const ps = await readPoolState(ctx, poolAddr);
    assertPoolIdentity(ctx, row, ps);
    recordPoolState(ctx, row, ps);
    if (ps.sqrtPriceX96 === 0n) {
      row.action = 'INITIALIZE';
      row.notes.push('pool existed but was never initialized');
      return row;
    }
    if (row.deviationPpb > C.MAX_PRICE_DEVIATION_PPB) {
      throw new PoolStop(STATUS.PRICE_MISMATCH, priceMismatchMessage(ctx, row));
    }
    const existing = findDeployedPosition(ctx, row, positions);
    if (existing) {
      row.action = 'VERIFY_ONLY';
      row.tokenId = existing.tokenId;
    } else {
      row.action = 'MINT';
    }
  } catch (err) {
    if (err instanceof DeploymentAbort) throw err;
    row.action = 'NONE';
    row.status = err instanceof PoolStop ? err.status : STATUS.FAILED;
    row.error = err instanceof PoolStop ? err.message : describeError(err);
  } finally {
    adoptPriorState(ctx, row);
  }
  return row;
}

const ACTION_TEXT = {
  CREATE: 'create + initialize pool, approve, mint full-range position, verify',
  INITIALIZE: 'initialize existing pool, approve, mint full-range position, verify',
  MINT: 'pool already at target price; approve and mint full-range position, verify',
  VERIFY_ONLY: 'deployer already holds a full-range position; verify only',
  NONE: 'no action',
};

async function preflight(ctx, rows) {
  const funding = rows.filter((r) => FUNDING_ACTIONS.has(r.action));
  const swapping = ctx.swapTest ? rows.filter((r) => (FUNDING_ACTIONS.has(r.action) || r.action === 'VERIFY_ONLY') && !r.swapTx) : [];
  const swapIn = parseUnits(C.VERIFY_SWAP_USDC, ctx.usdcInfo.decimals);

  const needUsdc = ctx.desiredUsdc * BigInt(funding.length) + swapIn * BigInt(swapping.length);
  const needToken = ctx.desiredToken * BigInt(funding.length);

  let gas = 0n;
  for (const row of funding) {
    if (row.action === 'CREATE' || row.action === 'INITIALIZE') {
      gas += await ctx.npm.createAndInitializePoolIfNecessary.estimateGas(ctx.token0, ctx.token1, row.fee, ctx.targetSqrtPriceX96);
    }
    gas += 2n * C.GAS_BUDGET.approve + C.GAS_BUDGET.mint;
  }
  gas += BigInt(swapping.length) * (C.GAS_BUDGET.approve + C.GAS_BUDGET.swap);
  gas = (gas * C.GAS_LIMIT_BUFFER_PCT) / 100n;
  const feeData = await ctx.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  const needEth = gas * maxFeePerGas;

  const [ethBal, usdcBal, tokenBal] = await Promise.all([
    ctx.provider.getBalance(ctx.address), ctx.usdc.balanceOf(ctx.address), ctx.token.balanceOf(ctx.address),
  ]);

  console.log(`\nBalances vs. requirement (${funding.length} pool(s) to fund${swapping.length ? `, ${swapping.length} test swap(s)` : ''}):`);
  const shortfalls = [];
  const line = (name, have, need, fmt) => {
    const ok = have >= need;
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(5)} have ${fmt(have)}, need ${fmt(need)}${ok ? '' : `  → missing ${fmt(need - have)}`}`);
    if (!ok) shortfalls.push(`${name}: missing ${fmt(need - have)}`);
  };
  line('ETH', ethBal, needEth, (v) => `${formatEther(v)} ETH`);
  line('USDC', usdcBal, needUsdc, (v) => fmtUsdc(ctx, v));
  line('TOKEN', tokenBal, needToken, (v) => fmtToken(ctx, v));
  console.log(`  (ETH need = ${gas} gas incl. 20% buffer × max fee ${formatUnits(maxFeePerGas, 'gwei')} gwei)`);
  return shortfalls;
}

// ───────────────────────────── execute ─────────────────────────────

async function executePool(ctx, row) {
  console.log(`\n── Fee ${row.fee} (${feePct(row.fee)}) ── ${ACTION_TEXT[row.action]}`);

  if (row.action === 'CREATE' || row.action === 'INITIALIZE') {
    const { hash } = await sendTx(ctx, {
      label: `fee ${row.fee}: createAndInitializePoolIfNecessary`,
      contract: ctx.npm, method: 'createAndInitializePoolIfNecessary',
      args: [ctx.token0, ctx.token1, row.fee, ctx.targetSqrtPriceX96],
    });
    row.initTx = hash;
    const poolAddr = getAddress(await ctx.factory.getPool(ctx.token0, ctx.token1, row.fee));
    if (poolAddr === ZeroAddress) throw new Error('factory still reports no pool after createAndInitializePoolIfNecessary');
    if (row.pool && row.pool !== poolAddr) throw new Error(`factory pool changed from ${row.pool} to ${poolAddr}`);
    row.pool = poolAddr;
    persist(ctx, row);
    console.log(`    pool ${poolAddr}`);
  }

  // Re-read right before committing funds: the pool may have been touched since planning.
  const ps = await readPoolState(ctx, row.pool);
  assertPoolIdentity(ctx, row, ps);
  if (ps.sqrtPriceX96 === 0n) throw new Error('pool is still uninitialized');
  recordPoolState(ctx, row, ps);
  console.log(`    price ${row.currentPrice} ${ctx.tokenInfo.symbol}/USDC (deviation ${formatPpbAsPercent(row.deviationPpb)}), tick ${row.tick}`);
  if (row.deviationPpb > C.MAX_PRICE_DEVIATION_PPB) throw new PoolStop(STATUS.PRICE_MISMATCH, priceMismatchMessage(ctx, row));

  if (row.action !== 'VERIFY_ONLY') await addLiquidity(ctx, row);
  await verifyPool(ctx, row);
}

async function addLiquidity(ctx, row) {
  for (const [addr, need] of [[ctx.token0, ctx.desired0], [ctx.token1, ctx.desired1]]) {
    const bal = await tokenContract(ctx, addr).balanceOf(ctx.address);
    if (bal < need) {
      const fmt = addr === ctx.usdcInfo.address ? fmtUsdc : fmtToken;
      throw new PoolStop(STATUS.INSUFFICIENT_BALANCE, `${symbolOf(ctx, addr)} balance ${fmt(ctx, bal)} < ${fmt(ctx, need)} required`);
    }
  }

  const npmAddr = getAddress(C.ADDRESSES.POSITION_MANAGER);
  await ensureAllowance(ctx, row, ctx.token0, npmAddr, 'PositionManager', ctx.desired0);
  await ensureAllowance(ctx, row, ctx.token1, npmAddr, 'PositionManager', ctx.desired1);

  const block = await ctx.provider.getBlock('latest');
  const params = {
    token0: ctx.token0,
    token1: ctx.token1,
    fee: row.fee,
    tickLower: row.tickLower,
    tickUpper: row.tickUpper,
    amount0Desired: ctx.desired0,
    amount1Desired: ctx.desired1,
    amount0Min: applyBps(ctx.desired0, C.MINT_SLIPPAGE_BPS),
    amount1Min: applyBps(ctx.desired1, C.MINT_SLIPPAGE_BPS),
    recipient: ctx.address,
    deadline: BigInt(block.timestamp + C.DEADLINE_SECONDS),
  };
  console.log(`    ticks [${row.tickLower}, ${row.tickUpper}] (spacing ${row.tickSpacing}); mins ${fmtUsdc(ctx, usdcOf(ctx, params.amount0Min, params.amount1Min))} / ${fmtToken(ctx, tokenOf(ctx, params.amount0Min, params.amount1Min))}`);

  const { hash, receipt } = await sendTx(ctx, {
    label: `fee ${row.fee}: mint full-range position`, contract: ctx.npm, method: 'mint', args: [params],
  });
  row.mintTx = hash;

  const npmLogs = receipt.logs.filter((l) => getAddress(l.address) === npmAddr);
  const increase = npmLogs.map((l) => ctx.npm.interface.parseLog(l)).find((e) => e?.name === 'IncreaseLiquidity');
  if (!increase) throw new Error(`mint tx ${hash} emitted no IncreaseLiquidity event`);
  row.tokenId = increase.args.tokenId;
  row.positionLiquidity = increase.args.liquidity;
  row.deposited0 = increase.args.amount0;
  row.deposited1 = increase.args.amount1;
  row.depositSource = 'mint receipt';
  row.swapTx = null;
  persist(ctx, row);

  const usdcUsed = usdcOf(ctx, row.deposited0, row.deposited1);
  const tokenUsed = tokenOf(ctx, row.deposited0, row.deposited1);
  console.log(`    LP NFT #${row.tokenId}, liquidity ${row.positionLiquidity}`);
  console.log(`    deposited ${fmtUsdc(ctx, usdcUsed)} + ${fmtToken(ctx, tokenUsed)}; ` +
    `unused ${fmtUsdc(ctx, ctx.desiredUsdc - usdcUsed)} + ${fmtToken(ctx, ctx.desiredToken - tokenUsed)}`);
}

async function verifyPool(ctx, row) {
  const checks = [];
  const check = (ok, what) => checks.push({ ok: Boolean(ok), what });

  const poolAddr = getAddress(await ctx.factory.getPool(ctx.token0, ctx.token1, row.fee));
  check(poolAddr !== ZeroAddress && poolAddr === row.pool, 'pool registered in factory');
  check((await ctx.provider.getCode(poolAddr)) !== '0x', 'pool has code');
  let ps = await readPoolState(ctx, poolAddr);
  recordPoolState(ctx, row, ps);
  check(ps.liquidity > 0n, 'pool liquidity > 0');
  check(row.deviationPpb <= C.MAX_PRICE_DEVIATION_PPB, 'pool price within 1% of target');

  const owner = getAddress(await ctx.npm.ownerOf(row.tokenId));
  check(owner === ctx.address, 'LP NFT owned by deployer');
  const pos = await ctx.npm.positions(row.tokenId);
  check(getAddress(pos.token0) === ctx.token0 && getAddress(pos.token1) === ctx.token1 && Number(pos.fee) === row.fee,
    'position token pair and fee');
  check(Number(pos.tickLower) === row.tickLower && Number(pos.tickUpper) === row.tickUpper, 'position is full range');
  check(pos.liquidity > 0n, 'position liquidity > 0');
  row.positionLiquidity = pos.liquidity;

  if (row.deposited0 == null) {
    // Original deposit isn't in the local record; report what the position is worth now.
    const block = await ctx.provider.getBlock('latest');
    const [a0, a1] = await ctx.npm.decreaseLiquidity.staticCall({
      tokenId: row.tokenId, liquidity: pos.liquidity, amount0Min: 0n, amount1Min: 0n,
      deadline: BigInt(block.timestamp + C.DEADLINE_SECONDS),
    });
    row.deposited0 = a0;
    row.deposited1 = a1;
    row.depositSource = 'current position value (original deposit not in local record)';
  }

  // Small quote: USDC -> TOKEN through this exact pool.
  const amountIn = parseUnits(C.VERIFY_SWAP_USDC, ctx.usdcInfo.decimals);
  const quote = await ctx.quoter.quoteExactInputSingle.staticCall({
    tokenIn: ctx.usdcInfo.address, tokenOut: ctx.tokenInfo.address, amountIn, fee: row.fee, sqrtPriceLimitX96: 0n,
  });
  const ud = 10n ** BigInt(ctx.usdcInfo.decimals);
  const td = 10n ** BigInt(ctx.tokenInfo.decimals);
  const { num, den } = C.TARGET_TOKEN_PER_USDC;
  const expectedOut = (amountIn * num * td * (1_000_000n - BigInt(row.fee))) / (den * ud * 1_000_000n);
  const diff = quote.amountOut > expectedOut ? quote.amountOut - expectedOut : expectedOut - quote.amountOut;
  const diffBps = (diff * 10_000n) / expectedOut;
  const impact = deviationPpb(
    tokenPerUsdcFromSqrtPrice(quote.sqrtPriceX96After, ctx.decimals),
    tokenPerUsdcFromSqrtPrice(ps.sqrtPriceX96, ctx.decimals),
  );
  check(quote.amountOut > 0n && diffBps <= C.QUOTE_TOLERANCE_BPS, `quote within ${C.QUOTE_TOLERANCE_BPS} bps of fee-adjusted target`);
  row.verification = `quote ${C.VERIFY_SWAP_USDC} USDC → ${formatUnits(quote.amountOut, ctx.tokenInfo.decimals)} ${ctx.tokenInfo.symbol} ` +
    `(expected ≈ ${formatUnits(expectedOut, ctx.tokenInfo.decimals)}, price impact ${formatPpbAsPercent(impact)})`;
  console.log(`    ${row.verification}`);

  if (ctx.swapTest && !row.swapTx) {
    const routerAddr = getAddress(C.ADDRESSES.SWAP_ROUTER_02);
    await ensureAllowance(ctx, row, ctx.usdcInfo.address, routerAddr, 'SwapRouter02', amountIn);
    const { hash, receipt } = await sendTx(ctx, {
      label: `fee ${row.fee}: verification swap ${C.VERIFY_SWAP_USDC} USDC → ${ctx.tokenInfo.symbol}`,
      contract: ctx.router, method: 'exactInputSingle',
      args: [{
        tokenIn: ctx.usdcInfo.address, tokenOut: ctx.tokenInfo.address, fee: row.fee, recipient: ctx.address,
        amountIn, amountOutMinimum: applyBps(quote.amountOut, C.SWAP_SLIPPAGE_BPS), sqrtPriceLimitX96: 0n,
      }],
    });
    row.swapTx = hash;
    const poolIface = new Contract(poolAddr, POOL_ABI).interface;
    const swap = receipt.logs.filter((l) => getAddress(l.address) === poolAddr)
      .map((l) => poolIface.parseLog(l)).find((e) => e?.name === 'Swap');
    check(swap, 'verification swap emitted Swap event');
    if (swap) {
      const tokenOut = -tokenOf(ctx, swap.args.amount0, swap.args.amount1);
      row.verification += `; swap tx ${hash}: received ${formatUnits(tokenOut, ctx.tokenInfo.decimals)} ${ctx.tokenInfo.symbol}`;
      console.log(`    swap received ${formatUnits(tokenOut, ctx.tokenInfo.decimals)} ${ctx.tokenInfo.symbol}`);
    }
    ps = await readPoolState(ctx, poolAddr);
    recordPoolState(ctx, row, ps);
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`    ${c.ok ? '✓' : '✗'} ${c.what}`);
  if (failed.length) throw new PoolStop(STATUS.FAILED, `verification failed: ${failed.map((c) => c.what).join('; ')}`);
  row.status = row.action === 'VERIFY_ONLY' ? STATUS.ALREADY_DEPLOYED : STATUS.SUCCESS;
}

// ───────────────────────────── output ─────────────────────────────

function summaryFields(ctx, row) {
  const usdcDep = row.deposited0 == null ? null : usdcOf(ctx, row.deposited0, row.deposited1);
  const tokenDep = row.deposited0 == null ? null : tokenOf(ctx, row.deposited0, row.deposited1);
  const fromReceipt = row.depositSource === 'mint receipt';
  const depositNote = row.deposited0 != null && !fromReceipt ? ' (current value)' : '';
  const approvals = row.approvals.length ? row.approvals.map((a) => `${a.token}→${a.spender}: ${a.hash}`).join('<br>') : '—';
  return {
    'Fee tier': row.fee,
    'Fee %': feePct(row.fee),
    'Pool address': row.pool ?? '—',
    'Tick spacing': row.tickSpacing ?? '—',
    token0: `${symbolOf(ctx, ctx.token0)} ${ctx.token0}`,
    token1: `${symbolOf(ctx, ctx.token1)} ${ctx.token1}`,
    'Target price': ctx.targetPriceLabel,
    'Current price': row.currentPrice ? `${row.currentPrice} ${ctx.tokenInfo.symbol}/USDC` : '—',
    sqrtPriceX96: row.sqrtPriceX96?.toString() ?? '—',
    'Current tick': row.tick ?? '—',
    'Pool liquidity': row.liquidity?.toString() ?? '—',
    'LP NFT tokenId': row.tokenId?.toString() ?? '—',
    'USDC deposited': usdcDep == null ? '—' : fmtUsdc(ctx, usdcDep) + depositNote,
    'TOKEN deposited': tokenDep == null ? '—' : fmtToken(ctx, tokenDep) + depositNote,
    'Unused USDC': fromReceipt ? fmtUsdc(ctx, ctx.desiredUsdc - usdcDep) : '—',
    'Unused TOKEN': fromReceipt ? fmtToken(ctx, ctx.desiredToken - tokenDep) : '—',
    'Init tx': row.initTx ?? (row.pool ? 'n/a (pool pre-existed or not recorded)' : '—'),
    'Approval txs': approvals,
    'Mint tx': row.mintTx ?? '—',
    Verification: row.verification ?? '—',
    Status: row.status,
    Notes: [...row.notes, row.error].filter(Boolean).join('; ') || '—',
  };
}

function printSummary(ctx, rows) {
  console.log('\n════════════════════════════ SUMMARY ════════════════════════════');
  const cols = ['Fee', 'Pool', 'Spacing', `Price (${ctx.tokenInfo.symbol}/USDC)`, 'Tick', 'NFT', 'USDC dep.', 'TOKEN dep.', 'Status'];
  const table = rows.map((r) => {
    const f = summaryFields(ctx, r);
    return [feePct(r.fee), r.pool ?? '—', String(f['Tick spacing']), r.currentPrice ?? '—', String(f['Current tick']),
      f['LP NFT tokenId'], f['USDC deposited'].replace(/ \(current value\)$/, '*'), f['TOKEN deposited'].replace(/ \(current value\)$/, '*'), r.status];
  });
  const widths = cols.map((c, i) => Math.max(c.length, ...table.map((t) => t[i].length)));
  const fmtRow = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmtRow(cols));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const t of table) console.log(fmtRow(t));
  if (table.some((t) => t[6].endsWith('*'))) console.log('* current position value; original deposit not in the local record');

  for (const row of rows) {
    console.log(`\n[fee ${row.fee}] ${row.status}`);
    for (const [k, v] of Object.entries(summaryFields(ctx, row))) console.log(`  ${k.padEnd(16)} ${String(v).replaceAll('<br>', '\n                   ')}`);
  }
}

function writeSummaryFile(ctx, rows) {
  const fields = rows.map((r) => summaryFields(ctx, r));
  const headers = Object.keys(fields[0]);
  const esc = (v) => String(v).replaceAll('|', '\\|');
  const lines = [
    '# Uniswap V3 USDC/TOKEN deployment — Ethereum Sepolia',
    '',
    `Generated ${new Date().toISOString()} by \`scripts/deploy-pools.mjs\`.`,
    '',
    `- Deployer: \`${ctx.address}\``,
    `- USDC: \`${ctx.usdcInfo.address}\` (${ctx.usdcInfo.decimals} decimals)`,
    `- TOKEN: \`${ctx.tokenInfo.address}\` (${ctx.tokenInfo.symbol}, ${ctx.tokenInfo.decimals} decimals)`,
    `- Target: ${ctx.targetPriceLabel} · per pool ${C.LIQUIDITY_PER_POOL.USDC} USDC + ${C.LIQUIDITY_PER_POOL.TOKEN} TOKEN, full range`,
    `- Target sqrtPriceX96: \`${ctx.targetSqrtPriceX96}\``,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...fields.map((f) => `| ${headers.map((h) => esc(f[h])).join(' | ')} |`),
    '',
  ];
  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, redact(lines.join('\n')));
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  installRedaction();
  const { dryRun, swapTest } = parseArgs();
  loadDotEnv();

  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim() || C.DEFAULT_RPC_URL;
  // cacheTimeout -1: every read hits the node (ethers otherwise reuses identical requests for 250ms).
  const provider = new JsonRpcProvider(rpcUrl, Network.from(C.SEPOLIA_CHAIN_ID), { staticNetwork: true, cacheTimeout: -1 });
  await assertSepolia(provider, 'at startup');
  const wallet = loadWallet(provider);
  const address = getAddress(wallet.address);
  console.log(`Deployment wallet: ${address}`);
  console.log(`Network: Sepolia (chainId ${C.SEPOLIA_CHAIN_ID}) via ${new URL(rpcUrl).host}${dryRun ? '  [DRY RUN: no transactions]' : ''}`);

  const ctx = {
    provider, wallet, address, dryRun, swapTest,
    usdc: new Contract(C.ADDRESSES.USDC, ERC20_ABI, wallet),
    token: new Contract(C.ADDRESSES.TOKEN, ERC20_ABI, wallet),
    factory: new Contract(C.ADDRESSES.FACTORY, FACTORY_ABI, provider),
    npm: new Contract(C.ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, wallet),
    quoter: new Contract(C.ADDRESSES.QUOTER_V2, QUOTER_V2_ABI, provider),
    router: new Contract(C.ADDRESSES.SWAP_ROUTER_02, SWAP_ROUTER_02_ABI, wallet),
    allowedTargets: new Set([C.ADDRESSES.USDC, C.ADDRESSES.TOKEN, C.ADDRESSES.POSITION_MANAGER, C.ADDRESSES.SWAP_ROUTER_02].map(getAddress)),
  };

  await verifyContracts(ctx);
  ctx.usdcInfo = await readTokenInfo(ctx.usdc, 'USDC');
  ctx.tokenInfo = await readTokenInfo(ctx.token, 'TOKEN');
  [ctx.token0, ctx.token1] = sortTokens(ctx.usdcInfo.address, ctx.tokenInfo.address).map(getAddress);
  ctx.usdcIsToken0 = ctx.token0 === ctx.usdcInfo.address;
  ctx.decimals = { usdcIsToken0: ctx.usdcIsToken0, usdcDecimals: ctx.usdcInfo.decimals, tokenDecimals: ctx.tokenInfo.decimals };

  // Per-pool amounts in raw units, and a guard that they encode the same price as the target.
  ctx.desiredUsdc = parseUnits(C.LIQUIDITY_PER_POOL.USDC, ctx.usdcInfo.decimals);
  ctx.desiredToken = parseUnits(C.LIQUIDITY_PER_POOL.TOKEN, ctx.tokenInfo.decimals);
  const { num, den } = C.TARGET_TOKEN_PER_USDC;
  if (ctx.desiredToken * 10n ** BigInt(ctx.usdcInfo.decimals) * den !== ctx.desiredUsdc * 10n ** BigInt(ctx.tokenInfo.decimals) * num) {
    throw new DeploymentAbort('LIQUIDITY_PER_POOL does not match TARGET_TOKEN_PER_USDC');
  }
  ctx.desired0 = ctx.usdcIsToken0 ? ctx.desiredUsdc : ctx.desiredToken;
  ctx.desired1 = ctx.usdcIsToken0 ? ctx.desiredToken : ctx.desiredUsdc;
  const ratio = targetRawRatio({ ...ctx.decimals, target: C.TARGET_TOKEN_PER_USDC });
  ctx.targetSqrtPriceX96 = encodeSqrtPriceX96(ratio.amount1, ratio.amount0);
  ctx.targetPriceLabel = `${formatRational(C.TARGET_TOKEN_PER_USDC, 0)} ${ctx.tokenInfo.symbol}/USDC`;

  console.log(`USDC:  ${ctx.usdcInfo.address} (${ctx.usdcInfo.symbol}, ${ctx.usdcInfo.decimals} decimals)`);
  console.log(`TOKEN: ${ctx.tokenInfo.address} (${ctx.tokenInfo.symbol}, ${ctx.tokenInfo.decimals} decimals)`);
  console.log(`token0 = ${symbolOf(ctx, ctx.token0)}, token1 = ${symbolOf(ctx, ctx.token1)}`);
  console.log(`Target 1 USDC = ${ctx.targetPriceLabel.split(' ')[0]} ${ctx.tokenInfo.symbol}; raw token1/token0 = ${ratio.amount1}/${ratio.amount0}; sqrtPriceX96 = ${ctx.targetSqrtPriceX96}`);
  console.log(`ETH balance: ${formatEther(await provider.getBalance(address))} ETH`);

  ctx.state = loadState(ctx);

  console.log('\nInspecting fee tiers…');
  const positions = await walletPositions(ctx);
  const rows = [];
  for (const fee of C.FEE_TIERS) {
    const row = await planPool(ctx, fee, positions);
    rows.push(row);
    const where = row.pool ? `pool ${row.pool}` : 'no pool yet';
    const what = row.status ? `${row.status}: ${row.error}` : ACTION_TEXT[row.action];
    console.log(`  fee ${String(fee).padEnd(5)} spacing ${String(row.tickSpacing ?? '?').padEnd(3)} ${where} → ${what}`);
  }

  const shortfalls = await preflight(ctx, rows);
  if (shortfalls.length) {
    for (const row of rows) {
      if (FUNDING_ACTIONS.has(row.action)) {
        row.status = STATUS.INSUFFICIENT_BALANCE;
        row.error = `aborted before any transaction: ${shortfalls.join('; ')}`;
      }
    }
  }

  if (dryRun) {
    for (const row of rows) row.status ??= `PLANNED (${row.action})`;
    printSummary(ctx, rows);
    console.log(`\nDry run complete. ${shortfalls.length ? 'Fix the shortfalls above before deploying.' : 'Run without --dry-run to deploy.'}`);
    return shortfalls.length ? 1 : 0;
  }

  // On a shortfall nothing is sent; existing positions are still verified (read-only).
  if (shortfalls.length) ctx.swapTest = false;
  for (const row of rows) {
    const runnable = row.action === 'VERIFY_ONLY' || (FUNDING_ACTIONS.has(row.action) && !shortfalls.length);
    if (runnable) {
      try {
        await executePool(ctx, row);
      } catch (err) {
        if (err instanceof DeploymentAbort) {
          row.status = STATUS.FAILED;
          row.error = err.message;
          persist(ctx, row);
          for (const r of rows) {
            if (r.status) continue;
            r.status = STATUS.FAILED;
            r.error = 'not attempted: run aborted earlier';
          }
          printSummary(ctx, rows);
          writeSummaryFile(ctx, rows);
          throw err;
        }
        row.status = err instanceof PoolStop ? err.status : STATUS.FAILED;
        row.error = err instanceof PoolStop ? err.message : describeError(err);
        console.log(`    ✗ ${row.status}: ${row.error}`);
      }
      persist(ctx, row);
    }
  }

  printSummary(ctx, rows);
  writeSummaryFile(ctx, rows);
  console.log(`\nSaved ${path.relative(ROOT, SUMMARY_FILE)} and ${path.relative(ROOT, STATE_FILE)}`);

  const complete = rows.every((r) => r.status === STATUS.SUCCESS || r.status === STATUS.ALREADY_DEPLOYED);
  console.log(complete ? 'All four fee-tier pools are deployed and verified.' : 'Deployment incomplete; see statuses above.');
  return complete ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nAborted: ${err instanceof DeploymentAbort ? err.message : describeError(err)}`);
    process.exit(1);
  },
);
