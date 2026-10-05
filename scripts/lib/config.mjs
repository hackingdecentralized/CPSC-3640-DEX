// Static deployment parameters. Nothing secret lives here: PRIVATE_KEY is read from the environment only.

export const SEPOLIA_CHAIN_ID = 11155111n;
export const DEFAULT_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
export const EXPLORER_TX = 'https://sepolia.etherscan.io/tx/';

export const ADDRESSES = {
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  TOKEN: '0xBc2BEfb9a8aA70AfA23F7451A0794466976B6974',
  // Canonical Sepolia WETH9; must equal NonfungiblePositionManager.WETH9() (checked at startup).
  WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  // Official Uniswap V3 deployments on Sepolia. Cross-checked on-chain at startup
  // (PositionManager / QuoterV2 / SwapRouter02 must all report this factory).
  FACTORY: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  POSITION_MANAGER: '0x1238536071E1c677A632429e3655c799b22cDA52',
  QUOTER_V2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  SWAP_ROUTER_02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
};

export const FEE_TIERS = [100, 500, 3000, 10000];

// One entry per TOKEN pool family, selected with --pair <key> (default: usdc). Each pairs TOKEN with a
// quote token. Human-readable amounts are converted to raw units with on-chain decimals.
//   target           TOKEN per quote token as an exact rational num/den
//   liquidity        full-range position per pool; must encode `target` (checked at startup)
//   verifySwap       quote-token size of the post-deployment quote / optional --swap
//   repricePushBudget  most quote token the --reprice price-moving swap may spend
//   wrapNative       quote is WETH: wrap the wallet's ETH to cover any WETH shortfall
export const PAIRS = {
  usdc: {
    quote: ADDRESSES.USDC,
    // 1 USDC = 10 TOKEN. First deployed at 20,000 TOKEN/USDC, then moved here with --reprice;
    // state entries written before targets were recorded belong to that original deployment.
    target: { num: 10n, den: 1n },
    legacyTarget: '20000/1',
    liquidity: { quote: '50', token: '500' },
    feeTiers: FEE_TIERS,
    verifySwap: '0.001',
    repricePushBudget: '0.01',
    wrapNative: false,
    stateFile: 'sepolia-uniswap-v3.json',
    summaryFile: 'sepolia-uniswap-v3-summary.md',
  },
  weth: {
    quote: ADDRESSES.WETH,
    // 1 ETH = 10,000 TOKEN
    target: { num: 10000n, den: 1n },
    liquidity: { quote: '0.1', token: '1000' },
    feeTiers: FEE_TIERS,
    verifySwap: '0.000001',
    repricePushBudget: '0.00001',
    wrapNative: true,
    stateFile: 'sepolia-uniswap-v3-weth.json',
    summaryFile: 'sepolia-uniswap-v3-weth-summary.md',
  },
};

// Existing pools further than this from the target are left untouched (PRICE_MISMATCH).
export const MAX_PRICE_DEVIATION_PPB = 10_000_000n; // 1%

// mint() amountMin = desired * (1 - 2%). Covers the allowed 1% pool-price deviation plus rounding.
export const MINT_SLIPPAGE_BPS = 200n;

// Post-deployment verification trade (size per pair: verifySwap; quote always, real swap only with --swap).
export const SWAP_SLIPPAGE_BPS = 100n;
// A quote may differ from the fee-adjusted target output by at most this much.
export const QUOTE_TOLERANCE_BPS = 200n;

export const DEADLINE_SECONDS = 20 * 60;
export const TX_CONFIRMATIONS = 1;
export const TX_TIMEOUT_MS = 5 * 60 * 1000;
export const GAS_LIMIT_BUFFER_PCT = 120n;

// --reprice withdraws the deployer's liquidity down to what keeps the price-moving swap under the
// pair's repricePushBudget, so the deployer mostly trades against nothing.
// decreaseLiquidity() amountMin = simulated amount * (1 - 1%).
export const WITHDRAW_SLIPPAGE_BPS = 100n;
// A deployer position at the target price worth less than this share of LIQUIDITY_PER_POOL is topped up
// (e.g. a reprice interrupted after the price moved but before liquidity was re-added).
export const TOP_UP_BELOW_PCT = 50n;

// Pre-flight ETH budget for txs that can't be estimated until earlier txs land.
// Pool creation is estimated exactly via eth_estimateGas.
export const GAS_BUDGET = { approve: 80_000n, wrap: 60_000n, mint: 700_000n, increase: 400_000n, withdraw: 400_000n, swap: 250_000n };
