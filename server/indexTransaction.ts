// import {
//   Connection,
//   clusterApiUrl,
//   PublicKey,
//   Logs,
//   Context,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
//   ParsedMessage,
//   SolanaJSONRPCError,
// } from "@solana/web3.js";
// import bs58 from "bs58";

// interface TransferEvent {
//   signature: string;
//   slot: number;
//   source: string;
//   destination: string;
//   amount: string;
// }

// interface SwapEvent {
//   signature: string;
//   slot: number;
//   program: string;
//   rawLogs: string[];
// }

// interface PoolInfo {
//   ammId: PublicKey;
//   tokenAccountA: PublicKey;
//   tokenAccountB: PublicKey;
// }

// function isParsedInst(
//   inst: ParsedInstruction | PartiallyDecodedInstruction
// ): inst is ParsedInstruction {
//   return (inst as ParsedInstruction).parsed !== undefined;
// }

// const API_KEY = "88e029e3-9c89-4b1a-a3f1-df636c0c0d44";
// const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
// const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// const connection = new Connection(HTTP_URL, {
//   commitment: "confirmed",
//   wsEndpoint: WS_URL,
// });

// const TOKEN_PROGRAM_ID = new PublicKey(
//   "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
// );

// const DEX_PROGRAM_IDS = [
//   new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
// ];

// async function fetchParsedTransaction(
//   signature: string
// ): Promise<ParsedMessage | null> {
//   const maxVersionOpt = {
//     commitment: "confirmed" as const,
//     maxSupportedTransactionVersion: 0,
//   };
//   const baseOpt = { commitment: "confirmed" as const };
//   let attempt = 0;

//   while (attempt < 5) {
//     try {
//       return (
//         (await connection.getParsedTransaction(signature, maxVersionOpt))
//           ?.transaction?.message ?? null
//       );
//     } catch (err: any) {
//       if (
//         err instanceof SolanaJSONRPCError &&
//         err.message.includes("Too Many Requests")
//       ) {
//         const delay = 500 * (attempt + 1);
//         await new Promise((r) => setTimeout(r, delay));
//         attempt++;
//         continue;
//       }
//       if (
//         err instanceof SolanaJSONRPCError &&
//         err.message.includes("Transaction version")
//       ) {
//         // Fallback without version support
//         try {
//           return (
//             (await connection.getParsedTransaction(signature, baseOpt))
//               ?.transaction?.message ?? null
//           );
//         } catch {
//           return null;
//         }
//       }
//       console.error("Error fetching parsed tx:", err);
//       return null;
//     }
//   }
//   return null;
// }

// function subscribeTransfers(
//   tokenMint: PublicKey,
//   onTransfer: (event: TransferEvent) => void
// ) {
//   connection.onLogs(
//     TOKEN_PROGRAM_ID,
//     async (logs: Logs, ctx: Context) => {
//       const { signature, err, logs: rawLogs } = logs;
//       const slot = ctx.slot;

//       for (const line of rawLogs) {
//         if (!line.startsWith("Program log: Instruction: Transfer")) continue;

//         const message = await fetchParsedTransaction(signature);
//         if (!message) continue;

//         for (const inst of message.instructions) {
//           if (!isParsedInst(inst)) continue;
//           const parsed = inst as ParsedInstruction;

//           if (
//             parsed.program === "spl-token" &&
//             parsed.parsed.type === "transferChecked" &&
//             parsed.parsed.info.mint === tokenMint.toBase58()
//           ) {
//             const { source, destination, amount } = parsed.parsed.info;
//             onTransfer({ signature, slot, source, destination, amount });
//           }
//         }
//       }
//     },
//     "confirmed"
//   );

//   console.log(`Listening for transfers of ${tokenMint.toBase58()}`);
// }

// function subscribeSwaps(
//   tokenMint: PublicKey,
//   onSwap: (event: SwapEvent) => void
// ) {
//   const mintStr = tokenMint.toBase58();

//   for (const programId of DEX_PROGRAM_IDS) {
//     connection.onLogs(
//       programId,
//       async (logs: Logs, ctx: Context) => {
//         const { signature, logs: rawLogs } = logs;
//         const message = await fetchParsedTransaction(signature);
//         if (!message) return;

//         const involvesMint = message.instructions.some(
//           (inst) =>
//             isParsedInst(inst) &&
//             JSON.stringify((inst as ParsedInstruction).parsed.info).includes(
//               mintStr
//             )
//         );

//         if (!involvesMint) return;

//         onSwap({
//           signature,
//           slot: ctx.slot,
//           program: programId.toBase58(),
//           rawLogs: rawLogs.filter((l) => l.startsWith("Program log:")),
//         });
//       },
//       "confirmed"
//     );

//     console.log(`Listening for swaps via ${programId.toBase58()}`);
//   }
// }

// async function getTopHolders(
//   tokenMint: PublicKey,
//   topN = 10
// ): Promise<{ address: string; amount: number }[]> {
//   const resp = await connection.getTokenLargestAccounts(tokenMint);
//   return resp.value.slice(0, topN).map((acc) => ({
//     address: acc.address.toBase58(),
//     amount: acc.uiAmount ?? 0,
//   }));
// }

// async function start(tokenMintAddress: string) {
//   const tokenMint = new PublicKey(tokenMintAddress);

//   subscribeTransfers(tokenMint, (evt) => {
//     console.log("🔄 Transfer event:", evt);
//   });

//   subscribeSwaps(tokenMint, (evt) => {
//     console.log("⚖️ Swap event:", evt);
//   });

//   setInterval(async () => {
//     const holders = await getTopHolders(tokenMint, 5);
//     console.log("🏆 Top holders:", holders);
//   }, 60_000);
// }

// start("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump");

import {
  Connection,
  PublicKey,
  Logs,
  Context,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  SolanaJSONRPCError,
} from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { struct, blob } from "@solana/buffer-layout";

// ─── Types ───────────────────────────────────────────────────────────
interface TransferEvent {
  signature: string;
  slot: number;
  source: string;
  destination: string;
  amount: string;
}

interface SwapEvent {
  signature: string;
  slot: number;
  program: string;
  rawLogs: string[];
}

function isParsedInst(
  inst: ParsedInstruction | PartiallyDecodedInstruction
): inst is ParsedInstruction {
  return (inst as ParsedInstruction).parsed !== undefined;
}

interface PoolInfo {
  ammId: PublicKey;
  tokenAccountA: PublicKey;
  tokenAccountB: PublicKey;
}

const API_KEY = "88e029e3-9c89-4b1a-a3f1-df636c0c0d44";
const HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const connection = new Connection(HTTP_URL, {
  commitment: "confirmed",
  wsEndpoint: WS_URL,
});

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const DEX_PROGRAM_IDS = [
  new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
];

let transferFetchCount = 0;
let swapFetchCount = 0;
const MAX_FETCHES = 2;

interface AmmLayoutFields {
  poolCoinVault: Uint8Array;
  poolPcVault: Uint8Array;
}

const AmmLayout = struct<AmmLayoutFields>([
  blob(116),
  blob(32, "poolCoinVault"), // this becomes a Uint8Array
  blob(32, "poolPcVault"),
]);
async function fetchParsedMessage(signature: string) {
  try {
    return (
      await connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
    )?.transaction?.message;
  } catch (err: any) {
    if (
      err instanceof SolanaJSONRPCError &&
      (err.code === -32015 || err.message.includes("Too Many Requests"))
    ) {
      console.warn(`Skipping fetch for ${signature}: ${err.message}`);
      return null;
    }
    console.error(`Error fetching tx ${signature}:`, err);
    return null;
  }
}

function subscribeTransfers(
  tokenMint: PublicKey,
  onTransfer: (evt: TransferEvent) => void
) {
  connection.onLogs(
    TOKEN_PROGRAM_ID,
    async (logs: Logs, ctx: Context) => {
      if (transferFetchCount >= MAX_FETCHES) return;
      const { signature, logs: rawLogs } = logs;
      const slot = ctx.slot;
      console.log("signature :", signature);

      for (const line of rawLogs) {
        console.log("line :", line);

        if (!line.includes("Instruction: Transfer")) continue;
        // throttle detailed fetches
        transferFetchCount++;
        const message = await fetchParsedMessage(signature);
        if (!message) continue;

        for (const inst of message.instructions) {
          if (!isParsedInst(inst)) continue;
          const { parsed } = inst;
          if (
            inst.program === "spl-token" &&
            parsed.type === "transferChecked" &&
            parsed.info.mint === tokenMint.toBase58()
          ) {
            onTransfer({
              signature,
              slot,
              source: parsed.info.source,
              destination: parsed.info.destination,
              amount: parsed.info.amount,
            });
          }
        }

        if (transferFetchCount >= MAX_FETCHES) break;
      }
    },
    "confirmed"
  );
  console.log(`Listening (throttled) for transfers of ${tokenMint.toBase58()}`);
}

function subscribeSwaps(
  tokenMint: PublicKey,
  onSwap: (evt: SwapEvent) => void
) {
  const mintStr = tokenMint.toBase58();

  for (const programId of DEX_PROGRAM_IDS) {
    connection.onLogs(
      programId,
      async (logs: Logs, ctx: Context) => {
        if (swapFetchCount >= MAX_FETCHES) return;
        const { signature, logs: rawLogs } = logs;
        console.log("swap signature: ", signature);

        swapFetchCount++;
        const message = await fetchParsedMessage(signature);
        if (!message) return;

        const involvesMint = message.instructions.some(
          (inst) =>
            isParsedInst(inst) &&
            JSON.stringify(inst.parsed.info).includes(mintStr)
        );
        if (!involvesMint) return;

        onSwap({
          signature,
          slot: ctx.slot,
          program: programId.toBase58(),
          rawLogs: rawLogs.filter((l) => l.startsWith("Program log:")),
        });
      },
      "confirmed"
    );
    console.log(`Listening (throttled) for swaps via ${programId.toBase58()}`);
  }
}

async function getTopHolders(
  tokenMint: PublicKey,
  topN = 10
): Promise<{ address: string; amount: number }[]> {
  const resp = await connection.getTokenLargestAccounts(tokenMint);
  return resp.value.slice(0, topN).map((acc) => ({
    address: acc.address.toBase58(),
    amount: acc.uiAmount ?? 0,
  }));
}
async function checkArbitrage(
  poolA: PoolInfo,
  poolB: PoolInfo
): Promise<{ priceA: number; priceB: number; spread: number }> {
  async function getPrice(pool: PoolInfo): Promise<number> {
    // 2) grab vault addresses from pool state
    console.log("ammId :", pool.ammId);

    const info = await connection.getAccountInfo(pool.ammId);
    console.log("info : ", info);

    if (!info) throw new Error("Pool state not found");
    const decoded = AmmLayout.decode(info.data);
    console.log("decoded :", decoded);

    if (!info) throw new Error("Pool not found");
    const { poolCoinVault, poolPcVault } = AmmLayout.decode(info.data);

    // 3) Wrap those into PublicKeys:
    const vaultA = new PublicKey(poolCoinVault);
    const vaultB = new PublicKey(poolPcVault);
    console.log("vaultA : ", vaultA);

    // 3) fetch their balances
    const balA = await connection.getTokenAccountBalance(vaultA, "confirmed");
    const balB = await connection.getTokenAccountBalance(vaultB, "confirmed");

    const reserveA = Number(balA.value.amount);
    const reserveB = Number(balB.value.amount);

    console.log("reserveA:", reserveA, "reserveB:", reserveB);
    return reserveB / reserveA;
  }

  const priceA = await getPrice(poolA);
  const priceB = await getPrice(poolB);
  const spread = Math.abs(priceA - priceB) / ((priceA + priceB) / 2);
  return { priceA, priceB, spread };
}

async function start(
  tokenMintAddress: string,
  poolA: PoolInfo,
  poolB: PoolInfo
) {
  const tokenMint = new PublicKey(tokenMintAddress);

  //   subscribeTransfers(tokenMint, (evt) => {
  //     console.log("🔄 Transfer event:", evt);
  //   });

  //   subscribeSwaps(tokenMint, async (evt) => {
  //     console.log("⚖️ Swap event:", evt);
  //   });

  const arb = await checkArbitrage(poolA, poolB);
  console.log("arb : ", arb);

  if (arb.spread > 0.01) {
    console.log("🚨 Arbitrage opportunity detected!", arb);
  }

  //   setInterval(async () => {
  //     const holders = await getTopHolders(tokenMint, 5);
  //     console.log("🏆 Top holders:", holders);
  //   }, 60000);
}

const poolAInfo: PoolInfo = {
  ammId: new PublicKey("Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw"),
  tokenAccountA: new PublicKey("So11111111111111111111111111111111111111112"),
  tokenAccountB: new PublicKey("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"),
};
const poolBInfo: PoolInfo = {
  ammId: new PublicKey("8wXA3oeY8EUpmHu2yqzr6k2WJEodTFLuKqTmoQJtM6wP"),
  tokenAccountA: new PublicKey("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"),
  tokenAccountB: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
};

start("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", poolAInfo, poolBInfo);
