// index.js
const express = require("express");
const cors = require("cors");

const { config } = require('./src/Utils/config.js');
const { GetMetaData } = require('./src/Blockchain/metaData.js');
const PoolAnalyzer = require('./src/Blockchain/poolAnalyzer.js')
const { logger } = require('./src/Utils/logger.js');
const GraduationDetector = require('./src/Controller/listener.js');
const sendTelegramMessage = require('./src/Database/alert.js');
// const { triggerNewTrade } = require("./src/Controller/monitor.js");

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ SERVICES ------------------ */

const detector = new GraduationDetector(
  config.PUBLIC_RPC_URL,
  config.PUBLIC_WS_URL
);

const analyzer = new PoolAnalyzer(config.PUBLIC_RPC_URL);


/*
  Token state store:
  tokenMint => {
    boosted: boolean,
    boostRating: number,
    metadata: object,
    createdAt: number
  }
*/
const tokenState = new Map();

/* ------------------ HEALTH ------------------ */

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Raydium Token Sniping Bot is running (On-chain + Boost mode)."
  });
});


function tryApprove(tokenMint) {
  const state = tokenState.get(tokenMint);
  if (!state) return;

  if (state.marketCap > 420 && state.liquidity > 70) {
    logger.info(`APPROVED → Boost confirmed`, {
      token: tokenMint,
      name: state.metadata?.name
    });

    const link = 'https://dexscreener.com/solana/' + tokenMint;
    sendTelegramMessage(
        `APPROVED: \n`+
        `Name: ${state.metadata?.name || tokenMint} \n`+
        `link: ${link} \n`+
        `Token address: ${tokenMint} \n`+
        `time launched: ${new Date(state.createdAt).toLocaleString()}`
    );

    // triggerNewTrade(tokenMint, 0.001, state.vault0, state.vault1);

    // Cleanup memory
    tokenState.delete(tokenMint);
  }
}

/* ------------------ BOOTSTRAP ------------------ */

async function main() {
  try {
    logger.info("Starting Dexscreener boost queue...");

    logger.info("Starting graduation detector...");
    detector.start();

    /* -------- GRADUATION EVENT -------- */
    detector.on('graduated', async (tokenData) => {
      const tokenMint = tokenData.token0Mint;
      logger.info(`TRIGGER → Token graduated: ${tokenMint}`);

      const result = await analyzer.analyzePool(tokenMint, tokenData.token1Mint, tokenData.token0Vault, tokenData.token1Vault);

      // Register state FIRtST (prevents race condition)
      tokenState.set(tokenMint, {
        vault0: tokenData.token0Vault,
        vault1: tokenData.token1Vault,
        liquidity: result.liquidity[tokenMint],
        marketCap: result.marketCaps[tokenMint],
        metadata: null,
        createdAt: Date.now()
      });

      try {
        const metadata = await GetMetaData(tokenMint);
        const state = tokenState.get(tokenMint);
        if (state) {
          state.metadata = metadata;
        }
      } catch (err) {
        logger.warn(`METADATA ERROR (${tokenMint}): ${err.message}`);
      }

      logger.info(`Analyzed token: ${tokenMint} | Market Cap: ${result.marketCaps[tokenMint]} | Liquidity: ${result.liquidity[tokenMint]}`);

      tryApprove(tokenMint)

      logger.info("--------------------------------------------------");
    });

    const PORT = config.PORT;
    app.listen(PORT, () =>
      logger.info(`✅ API server running on port ${PORT}`)
    );

  } catch (err) {
    logger.error(`BOOTSTRAP FAILURE: ${err.message}`);
    process.exit(1);
  }
}

/* ------------------ SHUTDOWN ------------------ */

process.on("SIGINT", async () => {
  logger.warn("Shutting down gracefully...");

  setTimeout(() => {
    logger.error("Forced exit after timeout");
    process.exit(1);
  }, 2000);

  process.exit(0);
});

/* ------------------ START ------------------ */

main();
