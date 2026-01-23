// index.js
const express = require("express");
const cors = require("cors");

const { config } = require('./src/Utils/config.js');
const { GetMetaData } = require('./src/Blockchain/metaData.js');
const { logger } = require('./src/Utils/logger.js');

const XScraper = require('./src/Controller/offChainAna.js');
const GraduationDetector = require('./src/Controller/listener.js');
const DexBoostQueue = require('./src/Controller/checkBoost.js');
const sendTelegramMessage = require('./src/Database/alert.js');

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ SERVICES ------------------ */
const scraper = new XScraper();
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
    offChainPassed: boolean,
    boosted: boolean,
    boostRating: number,
    metadata: object
  }
*/
const tokenState = new Map();

/* ------------------ HEALTH ------------------ */
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Raydium Token Sniping Bot is running."
  });
});

/* ------------------ OFF-CHAIN FILTER ------------------ */
function passesOffChainCriteria(analysis) {
  if (!analysis) return false;

  switch (analysis.type) {
    case 'community':
      return analysis.memberCount > 400;

    case 'post':
      return (
        analysis.isVerified === true &&
        analysis.engagement.comments > 400 &&
        analysis.engagement.likes > 3000
      );

    case 'profile':
    default:
      return (
        analysis.isVerified === true &&
        analysis.followerCount > 400
      );
  }
}

/* ------------------ FINAL APPROVAL ------------------ */
function tryApprove(tokenMint) {
  const state = tokenState.get(tokenMint);
  if (!state) return;

  // Require off-chain passed AND boost rating > 400
  if (state.offChainPassed && state.boosted && state.boostRating > 400) {
    logger.info(`APPROVED → Boost + Off-chain confirmed`, {
      token: tokenMint,
      name: state.metadata?.name,
      boostRating: state.boostRating
    });

    sendTelegramMessage(
      "APPROVED: Boost + Off-chain confirmed",
      {
        token: tokenMint,
        name: state.metadata?.name,
        boostRating: state.boostRating
      }
    );

    // Clean up state
    tokenState.delete(tokenMint);
  }
}

/* ------------------ BOOTSTRAP ------------------ */
async function main() {
  try {
    logger.info("Initializing off-chain scraper...");
    await scraper.init();

    logger.info("Starting Dexscreener boost queue...");
    boostQueue.start();

    logger.info("Starting graduation detector...");
    detector.start();

    /* -------- BOOST EVENT -------- */
    boostQueue.on("boosted", ({ tokenAddress, boostData }) => {
      const boostRating = boostData?.active || 0;

      if (boostRating <= 400) {
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

    /* -------- GRADUATION EVENT -------- */
    detector.on('graduated', async (tokenMint) => {
      logger.info(`TRIGGER → Token graduated: ${tokenMint}`);

      // Start boost monitoring immediately
      boostQueue.addToken(tokenMint);

      tokenState.set(tokenMint, {
        offChainPassed: false,
        boosted: false,
        boostRating: 0,
        metadata: null
      });

      try {
        const metadata = await GetMetaData(tokenMint);
        tokenState.get(tokenMint).metadata = metadata;

        if (!metadata?.twitterHandle) {
          logger.warn(`SKIP → No Twitter handle`);
          return;
        }

        const analysis = await scraper.enqueue(metadata.twitterHandle);

        if (!passesOffChainCriteria(analysis)) {
          logger.info(`REJECTED → Off-chain criteria failed`);
          return;
        }

        logger.info(`OFF-CHAIN PASSED → Waiting for boost`);
        tokenState.get(tokenMint).offChainPassed = true;

        // If boost already arrived earlier
        tryApprove(tokenMint);

      } catch (err) {
        logger.error(`PROCESSING ERROR (${tokenMint}): ${err.message}`);
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
  await scraper.close();
  process.exit(0);
});

/* ------------------ START ------------------ */
main();
