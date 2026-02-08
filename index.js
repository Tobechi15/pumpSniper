// index.js
const express = require("express");
const cors = require("cors");

const { config } = require("./src/Utils/config.js");
const { GetMetaData } = require("./src/Blockchain/metaData.js");
const PoolAnalyzer = require("./src/Blockchain/poolAnalyzer.js");
const { logger } = require("./src/Utils/logger.js");
const GraduationDetector = require("./src/Controller/listener.js");
const sendTelegramMessage = require("./src/Database/alert.js");
const XScraper = require("./src/Controller/offChainAna.js");

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ SERVICES ------------------ */
const scraper = new XScraper(); // browser-per-scrape
const detector = new GraduationDetector(
  config.PUBLIC_RPC_URL,
  config.PUBLIC_WS_URL
);
const analyzer = new PoolAnalyzer(config.PUBLIC_RPC_URL);

/* ------------------ TOKEN STATE ------------------ */
const tokenState = new Map();
const STATE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanupToken(tokenMint, reason = "cleanup") {
  tokenState.delete(tokenMint);
  logger.info(`Token ${tokenMint} cleaned up (${reason})`);
}

/* ------------------ HEALTH ------------------ */
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", service: "Raydium Sniper Bot" });
});

/* ------------------ OFF-CHAIN FILTER ------------------ */
function passesOffChainCriteria(analysis) {
  if (!analysis) return false;

  switch (analysis.type) {
    case "community":
      return analysis.memberCount > 400;

    case "post":
      return (
        analysis.isVerified &&
        analysis.engagement?.comments > 400 &&
        analysis.engagement?.likes > 3000
      );

    case "profile":
    default:
      return analysis.isVerified && analysis.followerCount > 400;
  }
}

/* ------------------ APPROVAL ------------------ */
function tryApprove(tokenMint) {
  const state = tokenState.get(tokenMint);
  if (!state || state.approved) return;

  const { marketCap, liquidity, analysis, metadata, createdAt } = state;

  if (
    marketCap > 420 &&
    liquidity > 70 &&
    passesOffChainCriteria(analysis)
  ) {
    state.approved = true;

    logger.info(`APPROVED → ${tokenMint}`);

    sendTelegramMessage(
      `APPROVED TOKEN\n
Name: ${metadata?.name || "Unknown"}
Market Cap: ${marketCap}
Liquidity: ${liquidity}
Link: https://dexscreener.com/solana/${tokenMint}
Launched: ${new Date(createdAt).toLocaleString()}`
    );

    cleanupToken(tokenMint, "approved");
  }
}

/* ------------------ BOOTSTRAP ------------------ */
async function main() {
  try {
    logger.info("Starting services...");

    detector.start();

    detector.on("graduated", async (tokenData) => {
      const tokenMint = tokenData.token0Mint;
      logger.info(`GRADUATED → ${tokenMint}`);

      let analysisResult;
      try {
        analysisResult = await analyzer.analyzePool(
          tokenMint,
          tokenData.token1Mint,
          tokenData.token0Vault,
          tokenData.token1Vault
        );
      } catch {
        logger.error(`POOL ANALYSIS FAILED → ${tokenMint}`);
        return;
      }

      const marketCap = analysisResult?.marketCaps?.[tokenMint] ?? 0;
      const liquidity = analysisResult?.liquidity?.[tokenMint] ?? 0;

      tokenState.set(tokenMint, {
        vault0: tokenData.token0Vault,
        vault1: tokenData.token1Vault,
        marketCap,
        liquidity,
        metadata: null,
        analysis: null,
        approved: false,
        createdAt: Date.now()
      });

      setTimeout(() => cleanupToken(tokenMint, "ttl-expired"), STATE_TTL);

      try {
        const metadata = await GetMetaData(tokenMint);
        if (!metadata?.twitterHandle) {
          cleanupToken(tokenMint, "no-twitter");
          return;
        }

        const analysis = await scraper.enqueue(metadata.twitterHandle);
        if (!analysis) {
          cleanupToken(tokenMint, "scrape-failed");
          return;
        }

        const state = tokenState.get(tokenMint);
        if (!state) return;

        state.metadata = metadata;
        state.analysis = analysis;

        tryApprove(tokenMint);
      } catch {
        cleanupToken(tokenMint, "metadata-error");
      }
    });

    app.listen(config.PORT, () =>
      logger.info(`API running on port ${config.PORT}`)
    );
  } catch (err) {
    logger.error(`BOOT FAILURE → ${err.message}`);
    process.exit(1);
  }
}

/* ------------------ SHUTDOWN ------------------ */
process.on("SIGINT", async () => {
  logger.warn("Graceful shutdown...");
  process.exit(0);
});

main();
