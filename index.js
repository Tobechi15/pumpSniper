// index.js
const express = require("express");
const cors = require("cors");

const { config } = require('./src/Utils/config.js');
const { GetMetaData } = require('./src/Blockchain/metaData.js');
const { logger } = require('./src/Utils/logger.js');

const GraduationDetector = require('./src/Controller/listener.js');
const DexBoostQueue = require('./src/Controller/checkBoost.js');
const sendTelegramMessage = require('./src/Database/alert.js');
const { triggerNewTrade } = require("./src/Controller/monitor.js");

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ SERVICES ------------------ */

const detector = new GraduationDetector(
  config.PUBLIC_RPC_URL,
  config.PUBLIC_WS_URL
);

const boostQueue = new DexBoostQueue({
  chainId: "solana",
  intervalMs: 8000,
  concurrency: 2
});

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

/* ------------------ FINAL APPROVAL ------------------ */

function tryApprove(tokenMint) {
  const state = tokenState.get(tokenMint);
  if (!state) return;

  if (state.boosted && state.boostRating >= 50) {
    logger.info(`APPROVED → Boost confirmed`, {
      token: tokenMint,
      name: state.metadata?.name,
      boostRating: state.boostRating
    });

    const link = 'https://dexscreener.com/solana/' + tokenMint;
    sendTelegramMessage(
        `APPROVED: Boost confirmed for: \n`+
        `Name: ${state.metadata?.name || tokenMint} \n`+
        `link: ${link} \n`+
        `Token address: ${tokenMint} \n`+
        `Boosted Rating: ${state.boostRating}`+
        `time launched: ${state.createdAt}`
    );

    // triggerNewTrade(tokenMint, 0.001, state.vault0, state.vault1); // Buy 0.001 SOL worth of the token

    // Cleanup memory
    tokenState.delete(tokenMint);
  }
}

/* ------------------ BOOTSTRAP ------------------ */

async function main() {
  try {
    logger.info("Starting Dexscreener boost queue...");
    boostQueue.start();

    logger.info("Starting graduation detector...");
    detector.start();

    /* -------- BOOST EVENT -------- */
    boostQueue.on("boosted", ({ tokenAddress, boostData }) => {
      const boostRating = boostData?.active || 0;

      if (boostRating <= 45) {
        logger.info(`BOOST IGNORED → Rating too low: ${boostRating}`, {
          token: tokenAddress
        });
        return;
      }

      logger.info(`BOOST DETECTED → ${tokenAddress}`, { boostRating });

      const state = tokenState.get(tokenAddress);
      if (!state) return;

      state.boosted = true;
      state.boostRating = boostRating;

      tryApprove(tokenAddress);
    });

    /* -------- BOOST EXPIRY EVENT -------- */
    boostQueue.on("expired", ({ tokenAddress, lifetimeMs }) => {
      logger.info(`BOOST TIMEOUT → Removing token state`, {
        token: tokenAddress,
        lifetimeMinutes: Math.floor(lifetimeMs / 60000)
      });

      if (tokenState.has(tokenAddress)) {
        tokenState.delete(tokenAddress);
      }
    });

    boostQueue.on("error", ({ tokenAddress, message }) => {
      logger.warn(`DexBoostQueue error → ${tokenAddress}: ${message}`);
    });

    /* -------- GRADUATION EVENT -------- */
    detector.on('graduated', async (tokenData) => {
      const tokenMint = tokenData.token0Mint;
      logger.info(`TRIGGER → Token graduated: ${tokenMint}`);

      // Register state FIRtST (prevents race condition)
      tokenState.set(tokenMint, {
        vault0: tokenData.token0Vault,
        vault1: tokenData.token1Vault,
        boosted: false,
        boostRating: 0,
        metadata: null,
        createdAt: Date.now()
      });

      // Start boost monitoring
      boostQueue.addToken(tokenMint);

      try {
        const metadata = await GetMetaData(tokenMint);
        const state = tokenState.get(tokenMint);
        if (state) {
          state.metadata = metadata;
        }
      } catch (err) {
        logger.warn(`METADATA ERROR (${tokenMint}): ${err.message}`);
      }

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
