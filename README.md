# CPSC 3640 DEX — Uniswap V3 pools on Sepolia

`scripts/deploy-pools.mjs` manages TOKEN (BULLDOGS) Uniswap V3 pools on Ethereum Sepolia, one per fee tier
(0.01%, 0.05%, 0.30%, 1.00%), for each pair in `PAIRS` (`scripts/lib/config.mjs`):

| `--pair` | Target | Full-range position per pool | Records |
|---|---|---|---|
| `usdc` (default) | 1 USDC = 10 TOKEN | 50 USDC + 500 TOKEN | `deployments/sepolia-uniswap-v3*.{json,md}` |
| `weth` | 1 WETH = 10,000 TOKEN | 0.1 WETH + 1,000 TOKEN | `deployments/sepolia-uniswap-v3-weth*.{json,md}` |

The USDC pools were first deployed at 1 USDC = 20,000 TOKEN with 50 USDC + 1,000,000 TOKEN each, then
moved to 1:10 with `--reprice`. The old records are kept under `history` in the state file.
Uniswap V3 pools hold WETH, not native ETH; for the `weth` pair the script wraps just enough of the
wallet's Sepolia ETH (`WETH.deposit`) before each mint.

| | Address |
|---|---|
| USDC (6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| WETH9 (18 decimals) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| TOKEN (BULLDOGS, 18 decimals) | `0xBc2BEfb9a8aA70AfA23F7451A0794466976B6974` |
| UniswapV3Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| NonfungiblePositionManager | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |

## Usage

```bash
npm install
cp .env.example .env      # then set PRIVATE_KEY (and optionally SEPOLIA_RPC_URL)
npm run deploy:dry        # read-only: checks balances, inspects pools, prints the plan
npm run deploy            # deploy (verifies each pool with a QuoterV2 quote)
npm run deploy:swap       # same, plus a real 0.001 USDC verification swap per pool
npm run deploy:weth:dry   # WETH pair: plan (shows ETH to wrap + gas)
npm run deploy:weth       # WETH pair: deploy
node scripts/deploy-pools.mjs --reprice --dry-run   # plan moving off-target pools to the target
node scripts/deploy-pools.mjs --reprice             # move them
npm test                  # unit tests for price / tick math and log redaction
```

`.env` is git-ignored. The key is read only from `PRIVATE_KEY`, removed from the process
environment after loading, and scrubbed from all console and file output. The script
prints only the derived wallet address.

## Behaviour

- **Chain guard:** aborts unless `eth_chainId` is exactly `11155111`, checked at startup and
  again before every transaction. Mainnet is called out explicitly.
- **Pre-flight:** reads decimals and balances on-chain. If USDC, TOKEN or ETH is short for the
  pools that still need funding, it aborts before sending anything and reports the missing amounts.
- **Per fee tier:** tick spacing comes from `factory.feeAmountTickSpacing`. `sqrtPriceX96` is computed
  exactly from the on-chain token order and decimals. The pool is created via
  `createAndInitializePoolIfNecessary` only if it is missing or uninitialised. Allowances are
  approved only when they are insufficient. Liquidity is minted full range at the widest ticks
  that are multiples of the tick spacing. `amountMin` is set to 98% of the desired amounts.
- **Existing pools:** a pool more than 1% from the target price is marked `PRICE_MISMATCH` and is not
  touched unless `--reprice` is given. If the deployer already holds a funded full-range position, the
  pool is `ALREADY_DEPLOYED` and only verified, so re-running is safe. A position at the target price that
  holds less than half the per-pool amounts is topped up via `increaseLiquidity`.
- **`--reprice`:** only allowed when the deployer's full-range NFT is the pool's only active liquidity and
  a QuoterV2 check finds no other positions between the current and target price. Per pool it:
  1. withdraws all but a sliver of the liquidity and collects it (one `multicall`),
  2. swaps at most the pair's `repricePushBudget` (0.01 USDC / 0.00001 WETH) with `sqrtPriceLimitX96` at the target,
  3. checks the price is within 1% of target, then
  4. adds `LIQUIDITY_PER_POOL` back to the same NFT and verifies.

  Every step re-reads chain state, so an interrupted run resumes when re-run. Status is `REPRICED`.
- **Every transaction:** checks the target is an allowlisted contract with code, simulates with
  `eth_call`, estimates gas, checks the ETH balance, then waits for the receipt. Reverts are recorded
  and never retried. A receipt timeout stops the run.
- **Verification:** factory lookup, pool liquidity > 0, `slot0` price and tick, LP NFT ownership and
  position details, the actual deposited and unused amounts from the mint receipt, and a small quote.

Results go to `deployments/sepolia-uniswap-v3-summary.md` (full per-tier table) and
`deployments/sepolia-uniswap-v3.json` (state reused by later runs).

## Testing against a local fork

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com   # keeps chainId 11155111
DEPLOYMENTS_DIR=/tmp/fork-deployments SEPOLIA_RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=<anvil test key> npm run deploy:swap
```

`DEPLOYMENTS_DIR` keeps fork results away from the real `deployments/` record. Fund the test
account's TOKEN on the fork with `anvil_setStorageAt`; TOKEN balances live in mapping slot 0.
