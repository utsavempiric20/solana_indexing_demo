import {
  Connection,
  PublicKey,
  Transaction,
  Commitment,
  TransactionInstruction,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  Raydium,
  PoolFetchType,
  ApiV3PoolInfoItem,
  liquidityStateV4Layout,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BN } from "bn.js";
import dotenv from "dotenv";
import { fetchPoolIdByToken } from "./raydiumSwapSdk2";
dotenv.config();

const RPC_URL =
  process.env.MAINNET_RPC_URL_1 || "https://solana-mainnet.api.syndica.io";
const WS_URL = process.env.WS_URL || "wss://solana-mainnet.api.syndica.io";
const OWNER_PUBKEY = new PublicKey(
  process.env.OWNER_PUBKEY || "HQmsmTXzUymb5o383iTNccakfF4f2AzwUy4uzBuUfCbG"
);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SLIPPAGE = new Decimal(process.env.SLIPPAGE_PCT || "0.005");
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const MIN_TVL = new Decimal(process.env.MIN_TVL_USD || "5000");
const MIN_TOKEN_RESERVE = new Decimal(process.env.MIN_TOKEN_RESERVE || "2000");
const MIN_USDC_RESERVE = new Decimal(process.env.MIN_USDC_RESERVE || "5000");

function normalize(raw: number, decimals: number): Decimal {
  return new Decimal(raw).div(Decimal.pow(10, decimals));
}

function parseReserves(pool: ApiV3PoolInfoItem) {
  const aAmt = new Decimal(pool.mintAmountA);
  const bAmt = new Decimal(pool.mintAmountB);
  const fee = new Decimal(pool.feeRate);

  if (pool.mintA.address === USDC_MINT) {
    return {
      quote: aAmt,
      base: bAmt,
      feeRate: fee,
    };
  } else if (pool.mintB.address === USDC_MINT) {
    return {
      quote: aAmt,
      base: bAmt,
      feeRate: fee,
    };
  }
  throw new Error("Pool does not involve USDC");
}

function midPrice(pool: ApiV3PoolInfoItem): Decimal {
  const { base, quote } = parseReserves(pool);
  return quote.div(base);
}

function getAmountOut(
  amountIn: Decimal,
  reserveIn: Decimal,
  reserveOut: Decimal,
  feeRate: Decimal
): Decimal {
  console.log("amountIn : ", amountIn);
  console.log("reserveIn : ", reserveIn);
  console.log("reserveOut : ", reserveOut);
  console.log("feeRate : ", feeRate);

  const amountAfterFee = amountIn.mul(Decimal.sub(1, feeRate));
  console.log("amountAfterFee : ", amountAfterFee);

  return amountAfterFee;
}

async function findPools(
  raydium: Raydium,
  tokenMint: string,
  tokenMint2: string,
  minTvlUsd = MIN_TVL
): Promise<{ cheap: ApiV3PoolInfoItem; expensive: ApiV3PoolInfoItem }> {
  const resp = await raydium.api.fetchPoolByMints({
    mint1: tokenMint,
    mint2: tokenMint2,
    type: PoolFetchType.All,
  });
  const allPools: ApiV3PoolInfoItem[] = Array.isArray(resp) ? resp : resp.data;

  const bigPools = allPools.filter((pool) => {
    if (new Decimal(pool.tvl).lt(minTvlUsd)) return false;
    if (new Decimal(pool.mintAmountA).lte(2000)) return false;
    if (new Decimal(pool.mintAmountB).lte(4000)) return false;

    return true;
  });

  if (bigPools.length < 2) {
    throw new Error(
      `Not enough large pools: found ${bigPools.length}, need ≥2 ` +
        `(TVL≥${minTvlUsd.toFixed()}, tokenReserve≥${MIN_TOKEN_RESERVE}, USDCReserve≥${MIN_USDC_RESERVE})`
    );
  }

  bigPools.sort((a, b) => midPrice(a).comparedTo(midPrice(b)));
  console.log("bigPools :", bigPools);

  return {
    cheap: bigPools[0],
    expensive: bigPools[bigPools.length - 1],
  };
}

async function checkArbitrage(
  raydium: Raydium,
  tokenMint: string,
  tokenMint2: string,
  initialUsdc: Decimal
): Promise<{
  cheap: ApiV3PoolInfoItem;
  expensive: ApiV3PoolInfoItem;
  tokensBought: Decimal;
  finalUsdc: Decimal;
  profit: Decimal;
}> {
  const { cheap, expensive } = await findPools(raydium, tokenMint, tokenMint2);

  const rCheap = parseReserves(cheap);
  const rExp = parseReserves(expensive);
  console.log("rCheap : ", rCheap);
  console.log("rExp : ", rExp);

  console.log(
    `Pools → cheap @${midPrice(cheap).toFixed(6)}, expensive @${midPrice(
      expensive
    ).toFixed(6)}`
  );

  // USDC → token
  const tokensBought = getAmountOut(
    initialUsdc,
    rCheap.quote,
    rCheap.base,
    rCheap.feeRate
  );
  console.log("tokensBought : ", tokensBought);

  // token → USDC
  const finalUsdc = getAmountOut(
    tokensBought,
    rExp.base,
    rExp.quote,
    rExp.feeRate
  );

  const profit = finalUsdc.sub(initialUsdc);
  return { cheap, expensive, tokensBought, finalUsdc, profit };
}

(async () => {
  const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const tokenMint2 = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
  const inputUsdc = new Decimal(10);
  const POOL_ID = await fetchPoolIdByToken(tokenMint2);

  const connection = new Connection(RPC_URL, {
    commitment: (process.env.COMMITMENT as Commitment) || "confirmed",
    wsEndpoint: WS_URL,
  });
  const raydium = await Raydium.load({
    connection,
    owner: OWNER_PUBKEY,
    cluster: "mainnet",
  });

  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId: POOL_ID!,
  });

  let initialUsdc = inputUsdc;
  if (tokenMint.toString() !== USDC_MINT) {
    const { base, quote, feeRate } = parseReserves(poolInfo);
    initialUsdc = getAmountOut(inputUsdc, base, quote, feeRate);
    console.log(
      `Converted ${inputUsdc.toFixed()} token → ${initialUsdc.toFixed()} USDC`
    );
  }

  console.log(`Starting arbitrage loop with ${initialUsdc.toFixed()} USDC`);
  setInterval(async () => {
    try {
      const { tokensBought, finalUsdc, profit } = await checkArbitrage(
        raydium,
        tokenMint,
        tokenMint2,
        initialUsdc
      );

      console.log(
        `Bought ${tokensBought.toFixed()} token, back to ${finalUsdc.toFixed()} USDC → profit ${profit.toFixed()}`
      );

      if (profit.gt(0)) {
        console.log("Profitable! executing on‑chain swaps…");
        // await executeArbitrage(
        //   connection,
        //   raydium,
        //   OWNER_PUBKEY,
        //   cheap,
        //   expensive,
        //   initialUsdc,
        //   tokensBought
        // );
      } else {
        console.log("No profitable opportunity right now.");
      }
    } catch (err) {
      console.error("Arb check error:", err);
    }
  }, POLL_MS);
})();
