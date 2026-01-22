// index.js
const express = require("express");
const cors = require("cors");
const path = require("path");

const { config } = require('./src/Utils/config.js');
const { GetMetaData } = require('./src/Blockchain/metaData.js');
const { logger } = require('./src/Utils/logger.js');
const { offChainAnalyze } = require('./src/Controller/offChainAna.js');
const GraduationDetector = require('./src/Controller/listener.js');
const sendTelegramMessage = require('./src/Database/alert.js')

const detector = new GraduationDetector(
  config.PUBLIC_RPC_URL,
  config.PUBLIC_WS_URL
);


const app = express();
app.use(cors());
app.use(express.json());

const LOG_FILE = path.join(__dirname, "./logs/app.log");

app.get("/api/health", async (req, res) => {
  try {
    res.json({ status: "OK", message: "Raydium Token Sniping Bot is running." });
  } catch (err) {
    logger.error(`Health check failed: ${err.message}`);
    res.status(500).json({ status: "ERROR", message: "Internal Server Error" });
  }
});

app.get("/api/balance", async (req, res) => {
  try {
    const balance = await getWalletBalance();
    res.json({ status: "OK", balance });
  } catch (err) {
    logger.error(`Balance check failed: ${err.message}`);
    res.status(500).json({ status: "ERROR", message: "Internal Server Error" });
  }
});


async function main() {
  try {
    /**
     * Centralized decision engine
     */
    const passesOffChainCriteria = (analysisResult) => {
      const analysis  = analysisResult;

      if (!analysis) return false;

      logger.info(JSON.stringify(analysis, null, 2));


      switch (analysis.type) {
        case 'community':
          return (
            analysis.memberCount > 400
          );

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
    };

    /**
     * Graduation Event Listener
     */
    detector.on('graduated', async (tokenMint) => {
      logger.info(`TRIGGER: Token graduated → ${tokenMint}`);

      try {
        const metadata = await GetMetaData(tokenMint);

        if (!metadata?.twitterHandle) {
          logger.warn(`SKIP: No Twitter handle for ${tokenMint}`);
          return;
        }

        logger.info(`Analyzing X source: ${metadata.twitterHandle}`);

        const analysisResult = await offChainAnalyze(metadata.twitterHandle);

        if (!analysisResult) {
          logger.warn(`Off-chain analysis failed for ${tokenMint}`);
          return;
        }

        if (!passesOffChainCriteria(analysisResult)) {
          logger.info(`REJECTED: Off-chain criteria not met`, {
            token: tokenMint,
            type: analysisResult.type
          });
          return;
        }

        logger.info(`APPROVED: Off-chain analysis passed`, {
          token: tokenMint,
          name: metadata.name,
          type: analysisResult.type
        });



        // await triggerNewTrade(tokenMint, 0.01);
        sendTelegramMessage(`APPROVED: Off-chain analysis passed`, {
          token: tokenMint,
          name: metadata.name,
          type: analysisResult.type
        });

      } catch (err) {
        logger.error(`ERROR processing ${tokenMint}: ${err.message}`);
      }
      logger.info('---------------------------------------------------------------')
    });

    /**
     * Start listener
     */
    detector.start();
    // Start API server
    const PORT = config.PORT
    app.listen(PORT, () => logger.info(`✅ API server running on port ${PORT}`));

  } catch(error) {
    logger.error(`Error initializing the bot: ${error.message}`);
  }
}

// --- Start Application ---
main();