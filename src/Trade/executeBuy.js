const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { PumpAmmSdk } = require("@pump-fun/pump-swap-sdk");
const bs58 = require("bs58").default;
const { config } = require("../Utils/config");
const { logger } = require("../Utils/logger.js");

const RPC_ENDPOINT = config.PUBLIC_RPC_URL;
const PRIVATE_KEY = config.WALLET_SECRET;

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// Initialize the SDK
const sdk = new PumpAmmSdk(connection);

/**
 * Executes a buy for any pump.fun token (Bonding Curve OR PumpSwap AMM)
 * @param {string} mintAddress - The token mint
 * @param {number} solAmount - Amount in SOL (e.g., 0.1)
 * @param {number} slippageBps - Slippage in basis points (100 = 1%)
 */
async function executeBuy(mintAddress, solAmount, slippageBps = 100) {
  try {
    const mint = new PublicKey(mintAddress);
    const lamports = BigInt(Math.floor(solAmount * 1_000_000_000));

    logger.info(`🚀 Preparing buy for ${mintAddress}...`);

    // 1. Fetch the state. 
    // The SDK automatically detects if it's on the curve or the AMM.
    const swapState = await sdk.swapSolanaState(mint, wallet.publicKey);

    // 2. Calculate the quote
    // buyQuoteInput returns the expected token output and required instructions
    const result = await sdk.buyQuoteInput(
      swapState,
      lamports,
      BigInt(slippageBps)
    );

    logger.info(`📦 Instructions generated. Signing and sending...`);

    // 3. Sign and Execute
    // The second argument [wallet] handles the automatic signing.
    const signature = await sdk.sendAndConfirm(
      result.instructions, 
      [wallet], 
      {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: "confirmed"
      }
    );

    logger.info(`✅ Success! Tx: https://solscan.io/tx/${signature}`);
    return signature;

  } catch (err) {
    logger.error("❌ executeBuy Error:", err.message || err);
    return null;
  }
}

module.exports = { executeBuy };