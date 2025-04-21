import { Connection, PublicKey } from "@solana/web3.js";
import { PoolFetchType, Raydium } from "@raydium-io/raydium-sdk-v2";
import { createCustomLogger } from "./utils/logger";

const logger = createCustomLogger("Arbitrage");

type Reserves = { reserveBase: number; reserveQuote: number };

function priceFromReserves(r: Reserves): number {
  return r.reserveQuote / r.reserveBase;
}

function calcSpread(priceA: number, priceB: number): number {
  return ((priceA - priceB) / priceB) * 100;
}

const fetchDataByPoolId = async (myPoolId: string) => {
  const raydium = await Raydium.load({ connection });
  const resp = await raydium.api.fetchPoolById({
    ids: myPoolId,
  });

  const pool = Array.isArray(resp) ? resp[0] : resp;

  const reserves: Reserves = {
    reserveBase: pool.mintAmountA,
    reserveQuote: pool.mintAmountB,
  };

  const sdkPrice = pool.price;
  const manualPrice = priceFromReserves(reserves);

  console.log("SDK reported price:", sdkPrice);
  console.log("Manual price:", manualPrice.toFixed(6));
  const spread = calcSpread(manualPrice, sdkPrice);
  console.log(`Spread vs other pool: ${spread.toFixed(2)}%`);
};

async function checkArb(
  connection: Connection,
  owner: PublicKey,

  mintA1: string,
  mintA2: string,

  mintB1: string,
  mintB2: string,
  threshold = 0.5
) {
  const raydium = await Raydium.load({ connection, owner });

  const poolAResp = await raydium.api.fetchPoolByMints({
    mint1: mintA1,
    mint2: mintA2,
    type: PoolFetchType.Standard,
  });
  const poolBResp = await raydium.api.fetchPoolByMints({
    mint1: mintB1,
    mint2: mintB2,
    type: PoolFetchType.Standard,
  });
  logger.info("poolAResp : ", poolAResp);
  logger.info("poolBResp : ", poolBResp);
  const [poolA] = Array.isArray(poolAResp) ? poolAResp : poolAResp.data;
  const [poolB] = Array.isArray(poolBResp) ? poolBResp : poolBResp.data;

  logger.info("-----------------------------------------------------------");
  logger.info("poolA : ", poolA);
  logger.info("-----------------------------------------------------------");
  logger.info("poolB : ", poolB);

  const reservesA: Reserves = {
    reserveBase: poolA.mintAmountA,
    reserveQuote: poolA.mintAmountB,
  };
  const reservesB: Reserves = {
    reserveBase: poolB.mintAmountA,
    reserveQuote: poolB.mintAmountB,
  };

  const priceA = priceFromReserves(reservesA);
  const priceB = priceFromReserves(reservesB);

  const spreadAB = calcSpread(priceA, priceB);
  const spreadBA = calcSpread(priceB, priceA);

  console.log(
    `Pool A price: ${priceA.toFixed(6)}  |  Pool B price: ${priceB.toFixed(6)}`
  );
  console.log(
    `A→B spread: ${spreadAB.toFixed(2)}%  |  B→A spread: ${spreadBA.toFixed(
      2
    )}%`
  );

  if (spreadAB > threshold) {
    console.log(
      `Buy on B @${priceB.toFixed(6)}, sell on A @${priceA.toFixed(
        6
      )} (spread ${spreadAB.toFixed(2)}%)`
    );
  } else if (spreadBA > threshold) {
    console.log(
      `Buy on A @${priceA.toFixed(6)}, sell on B @${priceB.toFixed(
        6
      )} (spread ${spreadBA.toFixed(2)}%)`
    );
  } else {
    console.log(`No arbitrage opportunity (spread < ${threshold}%)`);
  }

  return { priceA, priceB, spreadAB, spreadBA };
}

const API_KEY =
  "292iv8Ue3o1gCYjwJqyDFm3bntTaYUzYqh6jYu1zwRA53z2RkP7yrjQ24CuauusWfJxiAebPSayH2RT3oG3HeDV5yDs8n3eSSwD";
const HTTP_URL = `https://solana-mainnet.api.syndica.io/api-key/${API_KEY}`;
const WS_URL = `wss://solana-mainnet.api.syndica.io/api-key/${API_KEY}`;
const connection = new Connection(HTTP_URL, {
  commitment: "confirmed",
  wsEndpoint: WS_URL,
});

const OWNER_PUBKEY = new PublicKey(
  "HQmsmTXzUymb5o383iTNccakfF4f2AzwUy4uzBuUfCbG"
);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RAY_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

(async () => {
  setInterval(async () => {
    const { priceA, priceB, spreadAB, spreadBA } = await checkArb(
      connection,
      OWNER_PUBKEY,
      SOL_MINT,
      RAY_MINT,
      USDC_MINT,
      SOL_MINT,
      0.3
    );

    console.log({ priceA, priceB, spreadAB, spreadBA });
  }, 5000);
  // setInterval(async () => {
  //   await fetchDataByPoolId("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
  //   await fetchDataByPoolId("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
  // }, 5000);
})();
