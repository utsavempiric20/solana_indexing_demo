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
  console.log("allPools : ", allPools);

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

export async function executeArbitrage(
  connection: Connection,
  owner: Keypair,
  raydium: Raydium,
  cheap: ApiV3PoolInfoItem,
  expensive: ApiV3PoolInfoItem,
  initialUsdc: Decimal,
  tokensBought: Decimal
) {
  // 1) load full on-chain PoolKeys for each pool
  // const { poolKeys: cheapKeys } = await raydium.liquidity.getPoolInfoFromRpc({
  //   poolId: cheap.id,
  // });
  // const { poolKeys: expKeys } = await raydium.liquidity.getPoolInfoFromRpc({
  //   poolId: expensive.id,
  // });
  // // 2) derive associated token accounts (and create them if missing)
  // const ataUSDC = await getAssociatedTokenAddress(
  //   new PublicKey(USDC_MINT),
  //   owner.publicKey
  // );
  // // determine your target token mint
  // const tokenMint = new PublicKey(
  //   cheap.mintA.address === new PublicKey(USDC_MINT).toBase58()
  //     ? cheap.mintB.address
  //     : cheap.mintA.address
  // );
  // const ataToken = await getAssociatedTokenAddress(tokenMint, owner.publicKey);
  // const setupIxs = [];
  // if (!(await connection.getAccountInfo(ataUSDC))) {
  //   setupIxs.push(
  //     createAssociatedTokenAccountInstruction(
  //       owner.publicKey,
  //       ataUSDC,
  //       owner.publicKey,
  //       new PublicKey(USDC_MINT)
  //     )
  //   );
  // }
  // if (!(await connection.getAccountInfo(ataToken))) {
  //   setupIxs.push(
  //     createAssociatedTokenAccountInstruction(
  //       owner.publicKey,
  //       ataToken,
  //       owner.publicKey,
  //       tokenMint
  //     )
  //   );
  // }
  // const swap1 = await raydium.clmm.swap({
  //   connection,
  //   poolKeys: cheapKeys,
  //   userKeys: {
  //     owner: owner.publicKey,
  //     tokenAccounts: [ataUSDC, ataToken],
  //   },
  //   amountIn: initialUsdc,
  //   slippage: SLIPPAGE,
  //   fixedSide: "in",
  // });
  // const swap2 = await Liquidity.makeSwapTransaction({
  //   connection,
  //   poolKeys: expKeys,
  //   userKeys: {
  //     owner: owner.publicKey,
  //     tokenAccounts: [ataToken, ataUSDC],
  //   },
  //   amountIn: tokensBought, // Decimal from your simulation
  //   slippage: SLIPPAGE,
  //   fixedSide: "in",
  // });
  // // 4) combine into a single VersionedTransaction
  // const latest = await connection.getLatestBlockhash();
  // const messageV0 = new TransactionMessage({
  //   payerKey: owner.publicKey,
  //   recentBlockhash: latest.blockhash,
  //   instructions: [...setupIxs, ...swap1.instructions, ...swap2.instructions],
  // }).compileToV0Message();
  // const tx = new VersionedTransaction(messageV0);
  // // 5) sign & send
  // tx.sign([owner, ...swap1.signers, ...swap2.signers]);
  // const sig = await connection.sendRawTransaction(tx.serialize());
  // console.log("▶️ Arbitrage Tx:", sig);
  // await connection.confirmTransaction(sig, "finalized");
  // console.log("✅ Arbitrage executed!");
}

(async () => {
  const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const tokenMint2 = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
  const inputUsdc = new Decimal(10);

  const connection = new Connection(RPC_URL, {
    commitment: (process.env.COMMITMENT as Commitment) || "confirmed",
    wsEndpoint: WS_URL,
  });
  const raydium = await Raydium.load({
    connection,
    owner: OWNER_PUBKEY,
    cluster: "mainnet",
  });

  const poolId = "D5MzuR2BVKhhLe5S2LiWHeLUv4QVr1mc2MC2PWdHZWtU";
  const { poolKeys, poolInfo, poolRpcData } =
    await raydium.liquidity.getPoolInfoFromRpc({ poolId });

  console.log("poolKeys:", poolKeys);
  console.log("poolInfo", poolInfo);
  console.log("Base reserve:", poolRpcData.baseReserve.toString());
  console.log("Quote reserve:", poolRpcData.quoteReserve.toString());
  let initialUsdc = inputUsdc;
  if (tokenMint.toString() !== USDC_MINT) {
    const { cheap } = await findPools(raydium, tokenMint, tokenMint2);
    const { base, quote, feeRate } = parseReserves(cheap);
    initialUsdc = getAmountOut(inputUsdc, base, quote, feeRate);
    console.log(
      `Converted ${inputUsdc.toFixed()} token → ${initialUsdc.toFixed()} USDC`
    );
  }

  console.log(`Starting arbitrage loop with ${initialUsdc.toFixed()} USDC`);
  setInterval(async () => {
    try {
      const { cheap, expensive, tokensBought, finalUsdc, profit } =
        await checkArbitrage(raydium, tokenMint, tokenMint2, initialUsdc);

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
