import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolInfo,
  LiquidityPoolKeys,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  Percent,
  Token,
  TOKEN_PROGRAM_ID,
  TokenAmount,
  WSOL,
} from "@raydium-io/raydium-sdk";
import {
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import dotenv from "dotenv";
dotenv.config();

const connection = new Connection(
  process.env.MAINNET_RPC_URL_1 || "https://api.mainnet-beta.solana.com",
  {
    commitment: "confirmed",
  }
);

const getPoolKeys = async (
  ammId: string
): Promise<LiquidityPoolKeys | null> => {
  try {
    // Validate AMM ID
    // if (!PublicKey.isOnCurve(new PublicKey(ammId).toBuffer())) {
    //   throw new Error(`Invalid AMM ID: ${ammId}`);
    // }

    // Fetch AMM account
    const ammAccount = await connection.getAccountInfo(new PublicKey(ammId));

    if (!ammAccount) {
      throw new Error(`Failed to fetch AMM account for ID: ${ammId}`);
    }

    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(ammAccount.data);

    // Fetch Market account
    const marketAccount = await connection.getAccountInfo(poolState.marketId);
    if (!marketAccount) {
      throw new Error(
        `Failed to fetch Market account for Market ID: ${poolState.marketId}`
      );
    }

    const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

    // Generate market authority
    const marketAuthority = PublicKey.createProgramAddressSync(
      [
        marketState.ownAddress.toBuffer(),
        marketState.vaultSignerNonce.toArrayLike(Buffer, "le", 8),
      ],
      MAINNET_PROGRAM_ID.OPENBOOK_MARKET
    );

    // Return Pool Keys
    return {
      id: new PublicKey(ammId),
      programId: MAINNET_PROGRAM_ID.AmmV4,
      baseDecimals: poolState.baseDecimal.toNumber(),
      quoteDecimals: poolState.quoteDecimal.toNumber(),
      lpDecimals: 9,
      baseMint: poolState.baseMint,
      quoteMint: poolState.quoteMint,
      version: 4,
      openOrders: poolState.openOrders,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      authority: Liquidity.getAssociatedAuthority({
        programId: poolState.marketProgramId,
      }).publicKey,
      marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
      marketId: marketState.ownAddress,
      marketBids: marketState.bids,
      marketAsks: marketState.asks,
      marketEventQueue: marketState.eventQueue,
      marketBaseVault: poolState.baseVault,
      marketQuoteVault: poolState.quoteVault,
      marketAuthority: marketAuthority,
      targetOrders: poolState.targetOrders,
      lpMint: poolState.lpMint,
      withdrawQueue: poolState.withdrawQueue,
      lpVault: poolState.lpVault,
      marketVersion: 3,
      lookupTableAccount: PublicKey.default,
    };
  } catch (error) {
    console.error("Error in getPoolKeys:", (error as any).message);
    return null; // Return null in case of failure
  }
};

const calculateAmountOut = async (
  poolKeys: LiquidityPoolKeys,
  poolInfo: LiquidityPoolInfo,
  tokenToBuy: string,
  amountIn: number,
  rawSlippage: number
) => {
  // Validate amountIn and slippage
  if (amountIn <= 0) {
    throw new Error("Amount In must be greater than 0");
  }
  if (rawSlippage < 0 || rawSlippage > 100) {
    throw new Error("Slippage must be between 0 and 100");
  }

  const tokenOutMint = new PublicKey(tokenToBuy);
  const tokenOutDecimals = poolKeys.baseMint.equals(tokenOutMint)
    ? poolInfo.baseDecimals
    : poolKeys.quoteDecimals;

  const tokenInMint = poolKeys.baseMint.equals(tokenOutMint)
    ? poolKeys.quoteMint
    : poolKeys.baseMint;

  const tokenInDecimals = poolKeys.baseMint.equals(tokenOutMint)
    ? poolInfo.quoteDecimals
    : poolInfo.baseDecimals;

  // Initialize tokens
  const tokenIn = new Token(TOKEN_PROGRAM_ID, tokenInMint, tokenInDecimals);
  const tokenOut = new Token(TOKEN_PROGRAM_ID, tokenOutMint, tokenOutDecimals);

  // Create token amounts (ensure amountIn is correctly converted to the required amount)
  const tknAmountIn = new TokenAmount(tokenIn, amountIn, false);

  // Slippage as a Percent object
  const slippage = new Percent(rawSlippage, 100);

  // Compute the amount out from the pool (this could be a custom calculation)
  const amountOut = await Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn: tknAmountIn,
    currencyOut: tokenOut,
    slippage,
  });

  return {
    amountIn: tknAmountIn,
    tokenIn: tokenInMint,
    tokenOut: tokenOutMint,
    amountOut,
  };
};

const makeSwapInstruction = async (
  tokenToBuy: string,
  rawAmountIn: number,
  slippage: number,
  poolKeys: LiquidityPoolKeys,
  poolInfo: LiquidityPoolInfo,
  keyPair: Keypair
) => {
  // Calculate amount out with slippage
  const { amountIn, tokenIn, tokenOut, amountOut } = await calculateAmountOut(
    poolKeys,
    poolInfo,
    tokenToBuy,
    rawAmountIn,
    slippage
  );

  let tokenInAccount: PublicKey;
  let tokenOutAccount: PublicKey;
  let minAmountOut = amountOut.minAmountOut;

  try {
    // Handle the case for WSOL (native SOL)
    if (tokenIn.toString() === WSOL.mint) {
      tokenInAccount = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          keyPair,
          NATIVE_MINT,
          keyPair.publicKey
        )
      ).address;
      tokenOutAccount = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          keyPair,
          tokenOut,
          keyPair.publicKey
        )
      ).address;
    } else {
      // General case for other tokens
      tokenInAccount = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          keyPair,
          tokenIn,
          keyPair.publicKey
        )
      ).address;
      tokenOutAccount = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          keyPair,
          NATIVE_MINT,
          keyPair.publicKey
        )
      ).address;
    }
  } catch (error) {
    console.error("Error creating token accounts: ", error);
    throw new Error("Failed to create or get associated token accounts");
  }

  // Construct the transaction instruction
  const ix = new TransactionInstruction({
    programId: new PublicKey(poolKeys.programId),
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: poolKeys.id, isSigner: false, isWritable: true },
      { pubkey: poolKeys.authority, isSigner: false, isWritable: false },
      { pubkey: poolKeys.openOrders, isSigner: false, isWritable: true },
      { pubkey: poolKeys.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.quoteVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketProgramId, isSigner: false, isWritable: false },
      { pubkey: poolKeys.marketId, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketBids, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketAsks, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketEventQueue, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketBaseVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketQuoteVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketAuthority, isSigner: false, isWritable: false },
      { pubkey: tokenInAccount, isSigner: false, isWritable: true },
      { pubkey: tokenOutAccount, isSigner: false, isWritable: true },
      { pubkey: keyPair.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(
      Uint8Array.of(
        9, // Action code or instruction identifier
        ...new BN(amountIn.raw).toArray("le", 8), // Convert to little-endian byte array
        ...new BN(minAmountOut.raw).toArray("le", 8) // Convert to little-endian byte array
      )
    ),
  });

  return {
    swapIX: ix,
    tokenInAccount,
    tokenOutAccount,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
  };
};

export const executeTransaction = async (
  swapAmountIn: number,
  tokenToBuy: string,
  privateKey: string,
  ammId: string
) => {
  try {
    const secretKey = bs58.decode(privateKey);
    const keyPair = Keypair.fromSecretKey(secretKey);
    const slippage = 2; // 2% slippage tolerance

    const poolKeys = await getPoolKeys(ammId);
    console.log("poolKeys : ", poolKeys);

    if (!poolKeys) {
      throw new Error(`Could not get PoolKeys for AMM: ${ammId}`);
    }

    const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
    console.log("poolInfo : ", poolInfo);

    const txn = new Transaction();
    const {
      swapIX,
      tokenInAccount,
      tokenOutAccount,
      tokenIn,
      amountIn,
      minAmountOut,
    } = await makeSwapInstruction(
      tokenToBuy,
      swapAmountIn,
      slippage,
      poolKeys,
      poolInfo,
      keyPair
    );
    console.log(
      "getData from makeSwapInstruction : ",
      swapIX,
      tokenInAccount,
      tokenOutAccount,
      tokenIn,
      amountIn
    );

    // Check if we're swapping SOL to a token (tokenIn is WSOL)
    if (tokenIn.toString() == WSOL.mint) {
      // Convert SOL to Wrapped SOL (WSOL)
      txn.add(
        SystemProgram.transfer({
          fromPubkey: keyPair.publicKey,
          toPubkey: tokenInAccount,
          lamports: amountIn.raw.toNumber(), // amountIn is in lamports (1 SOL = 1e9 lamports)
        }),
        createSyncNativeInstruction(tokenInAccount, TOKEN_PROGRAM_ID)
      );
    }

    // Add the swap instruction to the transaction
    txn.add(swapIX);

    // If swapping token to SOL (tokenOut is WSOL), send back the wrapped SOL to the user's account
    if (tokenToBuy === WSOL.mint) {
      txn.add(
        createTransferCheckedInstruction(
          tokenInAccount,
          new PublicKey(WSOL.mint),
          tokenOutAccount,
          keyPair.publicKey,
          amountIn.raw.toNumber(),
          9,
          []
        )
      );
    }

    // Send and confirm the transaction
    const hash = await sendAndConfirmTransaction(connection, txn, [keyPair], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log("Transaction Completed Successfully");
    console.log(`Explorer URL: https://solscan.io/tx/${hash}`);
    return hash;
  } catch (error) {
    console.error("Error executing transaction:", error);
    return null;
  }
};

export const fetchData = async (tokenAddress: string) => {
  const { GraphQLClient } = await import("graphql-request");
  const endpoint = process.env.GRAPHQL_API_ENDPONIT!;
  const graphQLClient = new GraphQLClient(endpoint, {
    method: "POST",
  });

  const query = `
    query MyQuery($where: Raydium_LiquidityPoolv4_bool_exp) {
      Raydium_LiquidityPoolv4(where: $where) {
        pubkey
        baseMint
        quoteMint
      }
    }
  `;

  if (!tokenAddress) {
    return "Token parameter is required";
  }

  const variables = {
    where: {
      _or: [
        {
          _and: [
            {
              baseMint: { _eq: "So11111111111111111111111111111111111111112" },
            },
            { quoteMint: { _eq: tokenAddress } },
          ],
        },
        {
          _and: [
            { baseMint: { _eq: tokenAddress } },
            {
              quoteMint: { _eq: "So11111111111111111111111111111111111111112" },
            },
          ],
        },
      ],
    },
  };

  try {
    const data = await graphQLClient.request(query, variables);
    return (data as { Raydium_LiquidityPoolv4: Array<any> })
      .Raydium_LiquidityPoolv4[0].pubkey;
  } catch (error) {
    console.error("Error fetching data:", error);
    return null;
  }
};

async function main() {
  // @audit temp

  const TOKEN_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
  const inputAmount = 0.0001;
  const inputDecimals = 9;
  const privateKey = process.env.WALLET_PRIVATE_KEY;

  // const userTokenBalance = await getTokenBalance(
  //   "2U53Nbz1TcCw79ixoexpTFDG3qg1M9wigaYwDJCiQ44q",
  //   false
  // );

  // let tokenData;
  // if (isTokenBalance(userTokenBalance)) {
  //   tokenData = userTokenBalance.filter(
  //     (element) => element.mint.toString() === TOKEN_MINT
  //   );
  // }
  // // console.log(tokenData);

  //  For Sol to Token Swap
  const transactionHash = await executeTransaction(
    inputAmount,
    TOKEN_MINT,
    privateKey!,
    "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx"
  );

  // For Token to Sol Swap
  // const transactionHash = await swapTokens(
  //   TOKEN_MINT,
  //   USDC_MINT,
  //   tokenData![0].amount,
  //   tokenData![0].decimals,
  //   privateKey!,
  //   50
  // );
  console.log("transactionHash :", transactionHash);
}

main();
