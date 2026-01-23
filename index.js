// index.js
const express = require("express");
const cors = require("cors");
const path = require("path");

const { config } = require('./src/Utils/config.js');
const { GetMetaData } = require('./src/Blockchain/metaData.js');
const { logger } = require('./src/Utils/logger.js');

const XScraper = require('./src/Controller/offChainAna.js'); // queue-based scraper
const GraduationDetector = require('./src/Controller/listener.js');
const sendTelegramMessage = require('./src/Database/alert.js');

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ SERVICES ------------------ */
const scraper = new XScraper(); // single tab with queue
const detector = new GraduationDetector(
  config.PUBLIC_RPC_URL,
  config.PUBLIC_WS_URL
);

/* ------------------ HEALTH ENDPOINTS ------------------ */
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Raydium Token Sniping Bot is running."
  });
});

/* ------------------ OFF‑CHAIN FILTER ------------------ */
function passesOffChainCriteria(analysis) {
  if (!analysis) return false;

  logger.info(JSON.stringify(analysis, null, 2));

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

/* ------------------ MAIN BOOTSTRAP ------------------ */
async function main() {
  try {
    logger.info("Initializing off‑chain scraper...");
    await scraper.init(); // 🔥 single browser + queue

    logger.info("Starting graduation detector...");
    detector.start();

    detector.on('graduated', async (tokenMint) => {
      logger.info(`TRIGGER → Token graduated: ${tokenMint}`);

      try {
        const metadata = await GetMetaData(tokenMint);

        if (!metadata?.twitterHandle) {
          logger.warn(`SKIP → No Twitter handle for ${tokenMint}`);
          return;
        }

        logger.info(`Enqueueing scrape → ${metadata.twitterHandle}`);
        // 🔹 Use queue to prevent simultaneous navigation crashes
        const analysis = await scraper.enqueueScrape(metadata.twitterHandle);

        if (!analysis) {
          logger.warn(`FAILED → Off‑chain analysis error`);
          return;
        }

        if (!passesOffChainCriteria(analysis)) {
          logger.info(`REJECTED → Criteria not met`, {
            token: tokenMint,
            type: analysis.type
          });
          return;
        }

        logger.info(`APPROVED → Off‑chain validation passed`, {
          token: tokenMint,
          name: metadata.name,
          type: analysis.type
        });

        sendTelegramMessage(
          `APPROVED: Off‑chain analysis passed`,
          {
            token: tokenMint,
            name: metadata.name,
            type: analysis.type
          }
        );

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

/* ------------------ GRACEFUL SHUTDOWN ------------------ */
process.on("SIGINT", async () => {
  logger.warn("Shutting down gracefully...");
  await scraper.close();
  process.exit(0);
});

/* ------------------ START ------------------ */
main();
