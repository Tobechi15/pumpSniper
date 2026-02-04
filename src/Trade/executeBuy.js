const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const axios = require("axios"); // Swapping fetch for axios
const bs58 = require("bs58").default;
const { config } = require("../Utils/config");
const { logger } = require("../Utils/logger.js");

// const connection = new Connection(config.PUBLIC_RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(config.WALLET_SECRET));

// Constants for Jupiter Ultra
const JUP_ULTRA_URL = "https://api.jup.ag/ultra/v1";
const JUP_API_KEY = config.JUPITER_API_KEY; // Ensure this is in your config

/**
 * Executes an ultra-fast buy using Jupiter Ultra API
 */
async function executeBuy(mintAddress, solAmount) {
  try {
    const lamports = Math.floor(solAmount * 1_000_000_000);
    const inputMint = "So11111111111111111111111111111111111111112"; // WSOL

    logger.info(`🔥 Initiating Ultra Swap for ${mintAddress}...`);

    // 1. Create the Order
    // Ultra handles the routing and transaction creation in one go
    const { data: orderResponse } = await axios.get(`${JUP_ULTRA_URL}/order`, {
      params: {
        inputMint: inputMint,
        outputMint: mintAddress,
        amount: lamports.toString(),
        taker: wallet.publicKey.toString(),
      },
      headers: {
        "x-api-key": JUP_API_KEY,
      },
    });

    console.log("Order Response:", orderResponse);

    if (!orderResponse.transaction) {
      throw new Error("Failed to retrieve swap transaction from Ultra API");
    }

    // 2. Deserialize and Sign
    const swapTransactionBuf = Buffer.from(orderResponse.transaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // We sign here, but Jupiter Ultra often handles the broadcast/landing 
    // depending on your account tier and priority settings.
    transaction.sign([wallet]);

    // 3. Send via Ultra (Submit)
    // Note: Some Ultra setups prefer you POST the signed tx back to them 
    // to benefit from their proprietary landing service.
    const { data: submitResponse } = await axios.post(
      `${JUP_ULTRA_URL}/submit`,
      {
        signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": JUP_API_KEY,
        },
      }
    );

    logger.info(`✅ Ultra Tx Submitted! TxID: ${submitResponse.signature}`);
    return submitResponse.signature;

  } catch (err) {
    // Axios puts the error response in err.response.data
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err;
    logger.error("❌ Ultra Swap Error:", errorMsg);
    return null;
  }
}

module.exports = { executeBuy };