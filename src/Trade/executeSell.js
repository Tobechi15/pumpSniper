const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { PumpAmmSdk } = require("@pump-fun/pump-swap-sdk");
const bs58 = require("bs58").default;
const { config } = require("../Utils/config");
const { logger } = require("../Utils/logger.js");
const { getTokenBalance } = require("../Blockchain/getTokenBalance");

const RPC_ENDPOINT = config.PRIVATE_RPC_URL;
const PRIVATE_KEY = config.WALLET_SECRET;

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpAmmSdk(connection);

/**
 * Executes a flexible sell (Full, Percentage, or Fixed Amount)
 * @param {string} mintAddress - The token mint
 * @param {Object} options - { sellPercent: 50, fixedAmount: "1000000", expectedSol: 0.1 }
 */
async function executeSell(mintAddress, options = {}) {
  const { sellPercent = 100, fixedAmount = null, expectedSol = null, slippageBps = 300 } = options;

  try {
    const mint = new PublicKey(mintAddress);

    // 1. Get current total balance
    const { amount: totalBalance } = await getTokenBalance(mintAddress);
    
    if (!totalBalance || totalBalance === "0") {
      logger.error("❌ No balance found for this token.");
      return null;
    }

    // 2. Determine exact amount to sell (BigInt)
    let sellAmount;
    if (fixedAmount) {
      // Use a specific raw amount if provided
      sellAmount = BigInt(fixedAmount);
    } else {
      // Otherwise, calculate based on percentage (e.g., 50 for 50%)
      sellAmount = (BigInt(totalBalance) * BigInt(sellPercent)) / BigInt(100);
    }

    if (sellAmount <= 0n) {
      logger.error("❌ Calculated sell amount is zero.");
      return null;
    }

    logger.info(`🔄 Selling ${sellPercent}% (${sellAmount.toString()} units) of ${mintAddress}`);

    // 3. Fetch State & Quote
    const swapState = await sdk.swapSolanaState(mint, wallet.publicKey);
    const result = await sdk.sellBaseInput(
      swapState,
      sellAmount,
      BigInt(slippageBps)
    );

    // 4. Safety Check
    const expectedOutSol = Number(result.quote) / 1e9;
    if (expectedSol && expectedOutSol < Number(expectedSol)) {
        logger.error(`❌ Price too low. Expected ${expectedSol} SOL, got ${expectedOutSol} SOL`);
        return null;
    }

    // 5. Sign and Send
    const signature = await sdk.sendAndConfirm(
      result.instructions, 
      [wallet], 
      {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: "processed"
      }
    );

    logger.info(`✅ Flexible Sell Success: https://solscan.io/tx/${signature}`);
    return { signature, outAmount: result.quote.toString() };

  } catch (err) {
    logger.error("❌ executeSell error: " + (err.message || err));
    return null;
  }
}

module.exports = { executeSell };