# CPSC 3640 DEX — Uniswap V3 pools on Sepolia

`scripts/deploy-pools.mjs` creates a USDC/TOKEN Uniswap V3 pool for each fee tier
(0.01%, 0.05%, 0.30%, 1.00%) on Ethereum Sepolia. Each pool is initialised at
**1 USDC = 20,000 TOKEN** and seeded with a full-range position of **50 USDC + 1,000,000 TOKEN**.
The full run needs 200 USDC + 4,000,000 TOKEN plus Sepolia ETH for gas.

| | Address |
|---|---|
| USDC (6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
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
- **Existing pools:** a pool more than 1% from the target price is marked `PRICE_MISMATCH` and never
  touched. If the deployer already holds a full-range position, the pool is `ALREADY_DEPLOYED` and only
  verified, so re-running is safe.
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
SEPOLIA_RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=<anvil test key> npm run deploy:swap
```

Fund the test account's TOKEN on the fork with `anvil_setStorageAt`; TOKEN balances live in
mapping slot 0. Delete `deployments/` output afterwards, because fork transaction hashes don't exist
on the real Sepolia network.
