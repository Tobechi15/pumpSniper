const { executeBuy } = require("../Trade/executeBuy")
const { executeSell } = require("../Trade/executeSell");
const { getPrice } = require('../Blockchain/getPrice')
const { burner } = require("../Trade/closeRent");
const { logger } = require("../Utils/logger");
const Trade = require("../Database/models/Trade");
const { pendingTransactions } = require("../Database/transaction");

// Configuration
const POSITIONS = new Map(); // Tracks: { mint: { entryPrice, amount, step: 0 } }
const TAKE_PROFIT_LEVELS = [2.0, 3.5, 5.0]; // 2x, 3.5x, 5x
const SELL_PERCENTAGES = [0.25, 0.25, 0.50]; // Sell 25%, 25%, then remaining 50%

/**
 * Main Monitoring Loop
 */
async function monitorPrice() {

    logger.info(`👀 Monitoring started for: ${mintAddress}`);

    // In a production bot, replace this with a WebSocket listener 
    // for sub-second price updates.


    const priceInterval = setInterval(async () => {

        const tokens = await pendingTransactions();

        await Promise.all(tokens.map(async (token) => {
            try {
                const currentPrice = await getPrice(token.token_reserve.tokenReserve, token.token_reserve.baseReserve);

                const multiplier = currentPrice / token.buy_price;
                const currentStep = token.step;

                // Check if we hit the next Take Profit level
                if (multiplier >= TAKE_PROFIT_LEVELS[currentStep]) {
                    logger.info(`🎯 TP ${currentStep + 1} Hit! Price: ${currentPrice} (${multiplier.toFixed(2)}x)`);

                    const sellAmount = token.amountIn * SELL_PERCENTAGES[currentStep];
                    const sellSig = await executeSell(token.token_address, "So11111111111111111111111111111111111111112", 0);

                    if (sellSig) {
                        // Update the trade's step in the database
                        await Trade.updateOne({ _id: token.id }, { $inc: { step: 1 } });
                        // If final step, clean up
                        if (token.step >= TAKE_PROFIT_LEVELS.length - 1) {
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
        }));
    }, 1000); // Check every 2 seconds
}


//External trigger to add a new buy

async function triggerNewTrade(mintAddress, solAmount, state) {
    logger.info(`🚀 Signal Received: Buying ${solAmount} SOL of ${mintAddress}`);

    const buyResult = await executeBuy(mintAddress, solAmount);

    if (buyResult) {
        const entryPrice = await getPrice(state.vault0, state.vault1);
        POSITIONS.set(mintAddress, {
            entryPrice,
            amount: buyResult.outAmount,
            step: 0
        });

        const buyTrade = new Trade({
            tokenAddress: mintAddress,
            tokenReserve: { tokenReserve: state.vault0, baseReserve: state.vault1 },
            signature: buyResult,
            tokenName: state.metadata?.name,
            tokenSymbol: state.metadata?.symbol,
            buyPrice: entryPrice,
            amountIn: solAmount,
        });
        buyTrade.save();

        monitorPrice(mintAddress, state.vault0, state.vault1);
    }
    return buyResult;
}



module.exports = { triggerNewTrade };