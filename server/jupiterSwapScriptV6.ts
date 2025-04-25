// arbBot.ts
import "isomorphic-fetch";
import dotenv from "dotenv";
import Bottleneck from "bottleneck";
import {
  createJupiterApiClient,
  QuoteGetRequest,
  QuoteResponse,
  SwapInstructionsResponse,
} from "@jup-ag/api"; // Jupiter HTTP/WS API client
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────
const RPC_ENDPOINT = process.env.MAINNET_RPC_URL_1!;
const JUP_ENDPOINT = "https://quote-api.jup.ag/v6";
const SECRET_KEY_JSON = process.env.WALLET_PRIVATE_KEY!;
const raw = JSON.parse(process.env.WALLET_PRIVATE_KEY!);
const secret = Uint8Array.from(raw as number[]);
const wallet = Keypair.fromSecretKey(secret);

const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });
const jupiterApi = createJupiterApiClient({});
const limiter = new Bottleneck({ minTime: 20 }); // ~50 req/sec

// ─── Parameters ───────────────────────────────────────────────────────────
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKENS: string[] = [
  USDC_MINT,
  "So11111111111111111111111111111111111111112", // SOL
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // wBTC
];
const NOTIONAL = 1_000_000; // 10 USDC (6 decimals)
const SLIPPAGE_BPS = 30;
const MIN_PROFIT = 1000; // 0.01 USDC (in 1e6 units)

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Turn a Jupiter IX blob into a web3.js Instruction */
function ixFromData(data: any): TransactionInstruction | null {
  if (!data.data) return null;
  return new TransactionInstruction({
    programId: new PublicKey(data.programId),
    data: Buffer.from(data.data, "base64"),
    keys: data.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
  });
}

/**
 * FIX #1: Fetch each lookup table individually, then filter out nulls
 */
async function loadLookupTables(
  addresses: string[]
): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const results = await Promise.all(
    addresses.map((addr) =>
      connection.getAddressLookupTable(new PublicKey(addr))
    )
  );
  return results
    .map((r) => r.value)
    .filter((acct): acct is AddressLookupTableAccount => acct !== null);
}

/**
 * FIX #2 & #3: Manually build a single array of all instructions,
 * and flatten addressLookupTableAddresses via reduce → string[].
 */

interface BuiltTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}
async function buildAtomicArbTx(legs: QuoteResponse[]): Promise<BuiltTx> {
  const swapRes: SwapInstructionsResponse[] = [];
  for (const qr of legs) {
    const resp = await jupiterApi.swapInstructionsPost({
      swapRequest: {
        quoteResponse: qr,
        userPublicKey: wallet.publicKey.toBase58(),
        useSharedAccounts: false,
        prioritizationFeeLamports: { jitoTipLamports: 5000 },
        wrapAndUnwrapSol: true,
      },
    });
    swapRes.push(resp);
  }

  // Only budget + swapInstruction

  const instructions: TransactionInstruction[] = [
    // 1) budget + priority fee
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    // 2) any additional computeBudgetInstructions Jupiter returns
    ...swapRes[0].computeBudgetInstructions
      .map((ixData) => ixFromData(ixData))
      .filter((ix): ix is TransactionInstruction => !!ix),
    // 3) all swap instructions
    ...swapRes
      .map((r) => ixFromData(r.swapInstruction as any))
      .filter((ix): ix is TransactionInstruction => !!ix),
  ];
  swapRes[0].computeBudgetInstructions.forEach((cb) => {
    const ix = ixFromData(cb);
    if (ix) instructions.push(ix);
  });
  swapRes.forEach((r) => {
    const ix = ixFromData(r.swapInstruction as any);
    if (ix) instructions.push(ix);
  });

  // Load LUTs if any
  const lookupAddrs = Array.from(
    new Set(
      swapRes.reduce<string[]>(
        (acc, r) => acc.concat(r.addressLookupTableAddresses || []),
        []
      )
    )
  );

  // Compile message
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");

  const lookupTables = await loadLookupTables(lookupAddrs);
  console.log("instructions : ", instructions);
  console.log("lookupTables : ", lookupTables);

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);
  return { tx, blockhash, lastValidBlockHeight };
}
async function sendAtomicArb(
  legs: [QuoteResponse, QuoteResponse, QuoteResponse]
) {
  const { tx, blockhash, lastValidBlockHeight } = await buildAtomicArbTx(legs);

  const raw = tx.serialize();
  console.log("Raw tx size (bytes):", raw.length);
  // Check size under ~2048 bytes before sending
  if (raw.length > 2000) {
    throw new Error(`Transaction too large: ${raw.length} bytes`);
  }
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 2,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return sig;
}
// ─── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  // setInterval(async () => {
  outer: for (let i = 1; i < TOKENS.length; i++) {
    const tokenB = TOKENS[i];

    // Leg A: USDC → tokenB
    let qA: QuoteResponse;
    try {
      qA = await limiter.schedule(() =>
        jupiterApi.quoteGet({
          inputMint: USDC_MINT,
          outputMint: tokenB,
          amount: Number(NOTIONAL),
          slippageBps: SLIPPAGE_BPS,
          swapMode: "ExactIn",
        })
      );
    } catch {
      continue;
    }

    if (!qA.outAmount) continue;
    console.log("qA :", qA);

    for (let j = 1; j < TOKENS.length; j++) {
      const tokenC = TOKENS[j];
      if (tokenC === tokenB) continue;

      // Leg B: tokenB → tokenC
      let qB: QuoteResponse;
      try {
        qB = await limiter.schedule(() =>
          jupiterApi.quoteGet({
            inputMint: tokenB,
            outputMint: tokenC,
            amount: Number(qA.outAmount),
            slippageBps: SLIPPAGE_BPS,
            swapMode: "ExactIn",
          })
        );
      } catch {
        continue;
      }
      if (!qB.outAmount) continue;
      console.log("qB :", qB);
      // Leg C: tokenC → USDC
      let qC: QuoteResponse;
      try {
        qC = await limiter.schedule(() =>
          jupiterApi.quoteGet({
            inputMint: tokenC,
            outputMint: USDC_MINT,
            amount: Number(qB.outAmount),
            slippageBps: SLIPPAGE_BPS,
            swapMode: "ExactIn",
          })
        );
      } catch {
        continue;
      }
      if (!qC.outAmount) continue;
      console.log("qC :", qC);

      const profit = BigInt(qC.outAmount) - BigInt(NOTIONAL);
      console.log("profit :", profit);
      console.log("BigInt(MIN_PROFIT) :", BigInt(MIN_PROFIT));
      console.log(profit <= BigInt(MIN_PROFIT));

      if (profit <= BigInt(MIN_PROFIT)) continue;

      console.log(
        `🔍 Arb found: USDC→${tokenB.slice(0, 4)}→${tokenC.slice(
          0,
          4
        )}→USDC profit=${Number(profit) / 1e6} USDC`
      );
      const sig = await sendAtomicArb([qA, qB, qC]);
      console.log("✅ Atomic TX:", sig);
      break outer;
    }
  }
  // }, 10000);
}

main().catch(console.error);
