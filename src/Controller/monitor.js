const { executeBuy } = require("../Trade/executeBuy")
const { executeSell } = require("../Trade/executeSell");
const { burner } = require("../Trade/closeRent");
const { logger } = require("../Utils/logger");
const { Connection, PublicKey } = require("@solana/web3.js");
const { PumpAmmSdk } = require("@pump-fun/pump-swap-sdk");
const { config } = require("../Utils/config");

// Configuration
const POSITIONS = new Map(); // Tracks: { mint: { entryPrice, amount, step: 0 } }
const TAKE_PROFIT_LEVELS = [2.0, 3.5, 5.0]; // 2x, 3.5x, 5x
const SELL_PERCENTAGES = [0.25, 0.25, 0.50]; // Sell 25%, 25%, then remaining 50%




const connection = new Connection(config.PRIVATE_RPC_URL, "confirmed");
const sdk = new PumpAmmSdk(connection);

async function fetchCurrentPrice(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const swapState = await sdk.swapSolanaState(mint);
    
    const solReserves = Number(swapState.virtualSolReserves);
    const tokenReserves = Number(swapState.virtualTokenReserves);

    const priceInSol = (solReserves / 1e9) / (tokenReserves / 1e6);
    return priceInSol;

  } catch (err) {
    logger.error("❌ Failed to fetch SDK price:", err.message);
    return null;
  }
}
/**
 * Main Monitoring Loop
 */
async function monitorPrice(mintAddress) {
    if (POSITIONS.has(mintAddress)) return;

    logger.info(`👀 Monitoring started for: ${mintAddress}`);
    
    // In a production bot, replace this with a WebSocket listener 
    // for sub-second price updates.
    const priceInterval = setInterval(async () => {
        try {
            const currentPrice = await fetchCurrentPrice(mintAddress);
            const position = POSITIONS.get(mintAddress);

            if (!position) return;

            const multiplier = currentPrice / position.entryPrice;
            const currentStep = position.step;

            // Check if we hit the next Take Profit level
            if (multiplier >= TAKE_PROFIT_LEVELS[currentStep]) {
                logger.info(`🎯 TP ${currentStep + 1} Hit! Price: ${currentPrice} (${multiplier.toFixed(2)}x)`);
                
                const sellAmount = position.amount * SELL_PERCENTAGES[currentStep];
                const sellSig = await executeSell(mintAddress, "So11111111111111111111111111111111111111112", 0);

                if (sellSig) {
                    position.step += 1;
                    
                    // If final step, clean up
                    if (position.step >= TAKE_PROFIT_LEVELS.length) {
                        logger.info("🏁 Final Sell Complete. Reclaiming rent...");
                        clearInterval(priceInterval);
                        await burner(sellSig.signature, "sell");
                        POSITIONS.delete(mintAddress);
                    }
                }
            }
        } catch (err) {
            logger.error(`Error monitoring ${mintAddress}: ${err.message}`);
        }
    }, 2000); // Check every 2 seconds
}


//External trigger to add a new buy

async function triggerNewTrade(mintAddress, solAmount) {
    logger.info(`🚀 Signal Received: Buying ${solAmount} SOL of ${mintAddress}`);
    
    const buyResult = await swapToken(mintAddress, solAmount * 1e9);
    
    if (buyResult) {
        const entryPrice = await fetchCurrentPrice(mintAddress);
        POSITIONS.set(mintAddress, {
            entryPrice,
            amount: buyResult.outAmount,
            step: 0
        });
        monitorPrice(mintAddress);
    }
}



module.exports = { triggerNewTrade };