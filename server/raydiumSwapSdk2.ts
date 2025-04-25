// src/index.ts
import "dotenv/config";
import bs58 from "bs58";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { Raydium, SwapParam, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { GraphQLClient } from "graphql-request";

type RaydiumInstance = Awaited<ReturnType<typeof Raydium.load>>;

type PoolFetchResult = Awaited<
  ReturnType<RaydiumInstance["liquidity"]["getPoolInfoFromRpc"]>
>;

type PoolKeys = PoolFetchResult["poolKeys"];
type PoolInfo = PoolFetchResult["poolInfo"];
type PoolRpcData = PoolFetchResult["poolRpcData"];

function computeAmountOut(
  amountIn: BN,
  reserveIn: BN,
  reserveOut: BN,
  feeRate: number
): BN {
  const FEE_DEN = 10000;
  const feeNum = Math.round(feeRate * FEE_DEN);
  const keepNum = FEE_DEN - feeNum;
  const inWithFee = amountIn.muln(keepNum).divn(FEE_DEN);
  return inWithFee.mul(reserveOut).div(reserveIn.add(inWithFee));
}

function calculateAmountOutV2({
  poolKeys,
  poolInfo,
  poolRpcData,
  tokenToBuy,
  amountInHuman,
  slippagePercent,
}: {
  poolKeys: PoolKeys;
  poolInfo: PoolInfo;
  poolRpcData: PoolRpcData;
  tokenToBuy: string;
  amountInHuman: number;
  slippagePercent: number;
}) {
  const mintA = poolKeys.mintA.toString();
  const mintB = poolKeys.mintB.toString();
  const isBuyingA = tokenToBuy === mintA;

  const decimalsIn = isBuyingA
    ? poolInfo.mintB.decimals
    : poolInfo.mintA.decimals;
  const decimalsOut = isBuyingA
    ? poolInfo.mintA.decimals
    : poolInfo.mintB.decimals;
  const reserveIn = isBuyingA
    ? poolRpcData.quoteReserve
    : poolRpcData.baseReserve;
  const reserveOut = isBuyingA
    ? poolRpcData.baseReserve
    : poolRpcData.quoteReserve;

  const amountIn = new BN(amountInHuman).mul(
    new BN(10).pow(new BN(decimalsIn))
  );

  const rawOut = computeAmountOut(
    amountIn,
    reserveIn,
    reserveOut,
    poolInfo.feeRate
  );

  const keep = Math.round((100 - slippagePercent) * 100);
  const minOut = rawOut.muln(keep).divn(100 * 100);

  return { amountIn, minimumAmountOut: minOut };
}

function humanToRawBN(amountHuman: number, decimals: number): BN {
  const scaled = Math.floor(amountHuman * Math.pow(10, decimals));
  return new BN(scaled.toString());
}

export async function executeTransaction(args: {
  rpcUrl: string;
  walletSecretKey: string;
  poolId: string;
  amountInHuman: number;
  tokenToBuy: string;
  slippagePercent: number;
}): Promise<string> {
  const {
    rpcUrl,
    walletSecretKey,
    poolId,
    amountInHuman,
    tokenToBuy,
    slippagePercent,
  } = args;

  const connection = new Connection(rpcUrl, "confirmed");
  const owner = Keypair.fromSecretKey(bs58.decode(walletSecretKey));

  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: "mainnet",
  });

  const { poolKeys, poolInfo, poolRpcData } =
    await raydium.liquidity.getPoolInfoFromRpc({ poolId });
  console.log(poolInfo);

  const mintA = poolKeys.mintA.toString();
  const mintB = poolKeys.mintB.toString();
  const isBuyingA = tokenToBuy === mintA;

  const decimalsIn = isBuyingA
    ? poolInfo.mintB.decimals
    : poolInfo.mintA.decimals;
  const reserveIn = isBuyingA
    ? poolRpcData.quoteReserve
    : poolRpcData.baseReserve;
  const reserveOut = isBuyingA
    ? poolRpcData.baseReserve
    : poolRpcData.quoteReserve;

  const amountIn = humanToRawBN(amountInHuman, decimalsIn);

  const rawOut = computeAmountOut(
    amountIn,
    reserveIn,
    reserveOut,
    poolInfo.feeRate
  );
  const keep = Math.round((100 - slippagePercent) * 100);
  const minimumAmountOut = rawOut.muln(keep).divn(100 * 100);

  const swapParams: SwapParam<TxVersion.LEGACY> = {
    poolKeys,
    poolInfo,

    amountIn,
    amountOut: minimumAmountOut,
    inputMint: poolKeys.mintA.address,
    fixedSide: "in",
    txVersion: TxVersion.LEGACY,

    computeBudgetConfig: {},

    feePayer: owner.publicKey,
  };

  const { transaction, signers } = await raydium.liquidity.swap(swapParams);
  const sig = await sendAndConfirmTransaction(
    connection,
    transaction as Transaction,
    [owner, ...signers],
    { commitment: "confirmed" }
  );
  return sig;
}

export async function fetchPoolIdByToken(
  tokenMint: string
): Promise<string | null> {
  const endpoint = process.env.GRAPHQL_API_ENDPOINT!;
  const client = new GraphQLClient(endpoint, { method: "POST" });

  const query = `
    query($where: Raydium_LiquidityPoolv4_bool_exp) {
      Raydium_LiquidityPoolv4(where: $where) {
        pubkey
      }
    }
  `;
  const variables = {
    where: {
      _or: [
        {
          baseMint: { _eq: tokenMint },
          quoteMint: { _eq: "So11111111111111111111111111111111111111112" },
        },
        {
          baseMint: { _eq: "So11111111111111111111111111111111111111112" },
          quoteMint: { _eq: tokenMint },
        },
      ],
    },
  };

  const resp = await client.request<{
    Raydium_LiquidityPoolv4: { pubkey: string }[];
  }>(query, variables);

  return resp.Raydium_LiquidityPoolv4[0]?.pubkey ?? null;
}

async function main() {
  const RPC_URL = process.env.MAINNET_RPC_URL_1!;
  const SECRET_KEY = process.env.WALLET_PRIVATE_KEY!;
  const TOKEN_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
  const POOL_ID = await fetchPoolIdByToken(TOKEN_MINT);
  console.log(POOL_ID);

  if (!POOL_ID) throw new Error("Pool not found");

  const sig = await executeTransaction({
    rpcUrl: RPC_URL,
    walletSecretKey: SECRET_KEY,
    poolId: POOL_ID,
    amountInHuman: 0.001,
    tokenToBuy: TOKEN_MINT,
    slippagePercent: 1,
  });
  console.log("Final signature:", sig);
}

// main().catch(console.error);
