// arbitrageBot.ts
import {
  Connection,
  PublicKey,
  Transaction,
  Commitment,
} from "@solana/web3.js";
import {
  Raydium,
  PoolFetchType,
  ApiV3PoolInfoItem,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";

// ── CONFIG ────────────────────────────────────────────────────────────────
const API_KEY =
  "292iv8Ue3o1gCYjwJqyDFm3bntTaYUzYqh6jYu1zwRA53z2RkP7yrjQ24CuauusWfJxiAebPSayH2RT3oG3HeDV5yDs8n3eSSwD";
const HTTP_URL = `https://solana-mainnet.api.syndica.io/api-key/${API_KEY}`;
const WS_URL = `wss://solana-mainnet.api.syndica.io/api-key/${API_KEY}`;
const COMMITMENT = (process.env.COMMITMENT as Commitment) || "confirmed";
const OWNER_PUBKEY = new PublicKey(
  "HQmsmTXzUymb5o383iTNccakfF4f2AzwUy4uzBuUfCbG"
);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SLIPPAGE_PCT = new Decimal(process.env.SLIPPAGE_PCT || "0.5");
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
// ────────────────────────────────────────────────────────────────────────────

/** AMM formula: how many out you get for `amountIn` */
function getAmountOut(
  amountIn: Decimal,
  reserveIn: Decimal,
  reserveOut: Decimal,
  feeRate: Decimal
): Decimal {
  console.log("amountIn :", amountIn);
  console.log("reserveIn :", reserveIn);
  console.log("reserveOut :", reserveOut);
  console.log("feeRate :", feeRate);

  const afterFee = amountIn.mul(Decimal.sub(1, feeRate));
  console.log("afterFee :", afterFee);

  return afterFee.mul(reserveOut).div(reserveIn.add(afterFee));
}

/**
 * Take the raw pool data, normalize both vault balances by each token’s decimals,
 * and return { base, quote, feeRate } where:
 *   • base  = [your target token] reserve (human),
 *   • quote = [USDC] reserve (human).
 */
function parseReserves(pool: ApiV3PoolInfoItem) {
  const rawA = new Decimal(pool.mintAmountA);
  const rawB = new Decimal(pool.mintAmountB);

  if (pool.mintA.address === USDC_MINT) {
    // A = USDC, B = token
    return {
      quote: rawA, // USDC reserve (UI)
      base: rawB, // token reserve (UI)
      feeRate: new Decimal(pool.feeRate),
    };
  } else if (pool.mintB.address === USDC_MINT) {
    return {
      quote: rawA,
      base: rawB,
      feeRate: new Decimal(pool.feeRate),
    };
  } else {
    throw new Error("Pool not involving USDC");
  }
}

/** mid‑price = USDC per token */
function midPrice(pool: ApiV3PoolInfoItem): Decimal {
  const { base, quote } = parseReserves(pool);
  return quote.div(base);
}

/** fetch all token⇄USDC pools, return cheapest and priciest by mid‑price */
async function findPools(
  raydium: Raydium,
  tokenMint: string,
  minTvlUsd = new Decimal(1_000)
): Promise<{ cheap: ApiV3PoolInfoItem; expensive: ApiV3PoolInfoItem }> {
  const resp = await raydium.api.fetchPoolByMints({
    mint1: tokenMint,
    mint2: USDC_MINT,
    type: PoolFetchType.All,
  });
  const allPools = Array.isArray(resp) ? resp : resp.data;

  // 2) filter out low‑liquidity pools by TVL (or you could use mintAmountB, too)
  const goodPools = allPools.filter((p) =>
    // p.tvl is already in USD
    new Decimal(p.tvl).gte(minTvlUsd)
  );
  console.log("goodPools :", goodPools);

  if (goodPools.length < 2) {
    throw new Error(
      `Not enough pools above ${minTvlUsd.toFixed()} USD TVL for arbitrage`
    );
  }

  // 3) helper to get mid‑price = USDC reserve / token reserve
  function midPrice(pool: ApiV3PoolInfoItem) {
    // pool.mintAmountA/B are already human‑normalized
    const [usdcAmt, tokenAmt] =
      pool.mintA.address === USDC_MINT
        ? [new Decimal(pool.mintAmountA), new Decimal(pool.mintAmountB)]
        : [new Decimal(pool.mintAmountB), new Decimal(pool.mintAmountA)];
    return usdcAmt.div(tokenAmt);
  }

  // 4) sort filtered pools by price
  const sorted = goodPools.sort((a, b) => midPrice(a).comparedTo(midPrice(b)));

  return {
    cheap: sorted[0],
    expensive: sorted[sorted.length - 1],
  };
}

/**
 * Simulate USDC→token on the cheap pool, then token→USDC on the expensive one.
 * If profitable, execute both swaps in one atomic TX.
 */
async function simulateAndTrade(
  tokenMint: string,
  initialUsdc: Decimal,
  connection: Connection,
  raydium: Raydium
) {
  const { cheap, expensive } = await findPools(raydium, tokenMint);

  const rA = parseReserves(cheap);
  const rB = parseReserves(expensive);

  const tokens = getAmountOut(initialUsdc, rA.quote, rA.base, rA.feeRate);
  const finalUsdc = getAmountOut(tokens, rB.base, rB.quote, rB.feeRate);
  const profit = finalUsdc.sub(initialUsdc);

  console.log(
    `Prices → cheap: ${midPrice(cheap).toFixed(6)}, expensive: ${midPrice(
      expensive
    ).toFixed(6)}`
  );
  console.log(
    `Initial USDC: ${initialUsdc.toFixed(6)}, Final USDC: ${finalUsdc.toFixed(
      6
    )}, Profit: ${profit.toFixed(6)}`
  );

  if (profit.lte(0)) {
    console.log("No profitable arb right now.");
    return;
  }
  console.log("Profitable! executing swaps…");

  // load owner token accounts
  // await raydium.tokenAccounts.loadOwnerTokenAccounts();
  // const all = raydium.tokenAccounts.getAllTokenAccounts();
  // const usdcAcc = all.find(a => a.mint.toBase58() === USDC_MINT);
  // const tokAcc  = all.find(a => a.mint.toBase58() === tokenMint);
  // if (!usdcAcc || !tokAcc) throw new Error("Missing USDC or target token account");

  // // build and sign both swaps
  // const { transaction: tx1, signers: s1 } = await raydium.liquidity.swap({
  //   poolKeys: cheap,
  //   amountIn: initialUsdc,
  //   slippage: SLIPPAGE_PCT,
  //   inputTokenAccount: usdcAcc.pubkey,
  //   outputTokenAccount: tokAcc.pubkey,
  // });
  // const { transaction: tx2, signers: s2 } = await raydium.liquidity.swap({
  //   poolKeys: expensive,
  //   amountIn: tokens,
  //   slippage: SLIPPAGE_PCT,
  //   inputTokenAccount: tokAcc.pubkey,
  //   outputTokenAccount: usdcAcc.pubkey,
  // });

  // const tx = new Transaction()
  //   .add(...tx1.instructions)
  //   .add(...tx2.instructions);
  // tx.feePayer = OWNER_PUBKEY;
  // tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  // tx.partialSign(...s1, ...s2);

  // const sig = await connection.sendRawTransaction(tx.serialize());
  // console.log("Swap TX:", sig);
  // await connection.confirmTransaction(sig, COMMITMENT);
  console.log("Arbitrage complete!");
}

(async () => {
  const tokenMint = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
  const inputTokens = new Decimal(10);

  const connection = new Connection(HTTP_URL, {
    commitment: COMMITMENT,
    wsEndpoint: WS_URL,
  });
  const raydium = await Raydium.load({ connection, owner: OWNER_PUBKEY });

  // if the user input token ≠ USDC, convert to initial USDC using best pool
  let initialUsdc = inputTokens;
  if (tokenMint.toString() !== USDC_MINT) {
    const { cheap } = await findPools(raydium, tokenMint);
    const { base, quote, feeRate } = parseReserves(cheap);
    console.log(base, quote, feeRate);

    initialUsdc = getAmountOut(inputTokens, base, quote, feeRate);
  }

  console.log("Starting arbitrage loop; initial USDC:", initialUsdc.toFixed(6));
  setInterval(
    () =>
      simulateAndTrade(tokenMint, initialUsdc, connection, raydium).catch(
        console.error
      ),
    POLL_MS
  );
})();
