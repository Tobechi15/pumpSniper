// index.js
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

/**
 * Centralized decision engine
 */
const passesOffChainCriteria = (analysisResult) => {
  const { type, analysis } = analysisResult;

  if (!analysis) return false;

  logger.info(JSON.stringify(analysis, null, 2));
  

  switch (type) {
    case 'community':
      return (
        analysis.audienceSize > 990 &&
        analysis.credibilityScore >= 6 &&
        analysis.engagementQuality === 'organic'
      );

    case 'post':
      return (
        analysis.credibilityScore >= 7 &&
        analysis.engagementQuality === 'organic' &&
        analysis.isVerified === true
      );

    case 'profile':
    default:
      return (
        analysis.engagementQuality === 'organic' &&
        analysis.isVerified === true &&
        analysis.audienceSize > 800
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
});

/**
 * Start listener
 */
detector.start();
