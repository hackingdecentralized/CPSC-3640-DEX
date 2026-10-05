// Static deployment parameters. Nothing secret lives here: PRIVATE_KEY is read from the environment only.

export const SEPOLIA_CHAIN_ID = 11155111n;
export const DEFAULT_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
export const EXPLORER_TX = 'https://sepolia.etherscan.io/tx/';

export const ADDRESSES = {
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  TOKEN: '0xBc2BEfb9a8aA70AfA23F7451A0794466976B6974',
  // Official Uniswap V3 deployments on Sepolia. Cross-checked on-chain at startup
  // (PositionManager / QuoterV2 / SwapRouter02 must all report this factory).
  FACTORY: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  POSITION_MANAGER: '0x1238536071E1c677A632429e3655c799b22cDA52',
  QUOTER_V2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  SWAP_ROUTER_02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
};

export const FEE_TIERS = [100, 500, 3000, 10000];

// Human-readable liquidity per pool; converted to raw units with on-chain decimals.
export const LIQUIDITY_PER_POOL = { USDC: '50', TOKEN: '1000000' };

// Target price as an exact rational: TOKEN per USDC = num / den  (1 USDC = 20,000 TOKEN).
export const TARGET_TOKEN_PER_USDC = { num: 20000n, den: 1n };

// Existing pools further than this from the target are left untouched (PRICE_MISMATCH).
export const MAX_PRICE_DEVIATION_PPB = 10_000_000n; // 1%

// mint() amountMin = desired * (1 - 2%). Covers the allowed 1% pool-price deviation plus rounding.
export const MINT_SLIPPAGE_BPS = 200n;

// Post-deployment verification trade size (quote always; real swap only with --swap).
export const VERIFY_SWAP_USDC = '0.001';
export const SWAP_SLIPPAGE_BPS = 100n;
// A quote may differ from the fee-adjusted target output by at most this much.
export const QUOTE_TOLERANCE_BPS = 200n;

export const DEADLINE_SECONDS = 20 * 60;
export const TX_CONFIRMATIONS = 1;
export const TX_TIMEOUT_MS = 5 * 60 * 1000;
export const GAS_LIMIT_BUFFER_PCT = 120n;

// Pre-flight ETH budget for txs that can't be estimated until earlier txs land.
// Pool creation is estimated exactly via eth_estimateGas.
export const GAS_BUDGET = { approve: 80_000n, mint: 700_000n, swap: 250_000n };
