const {
  Connection,
  Keypair,
  PublicKey,
} = require("@solana/web3.js");
const bs58 = require("bs58").default;
const { config } = require("../Utils/config");
const { logger } = require("../Utils/logger.js");

const RPC_ENDPOINT = config.PUBLIC_RPC_URL; // RPC endpoint
const PRIVATE_KEY = config.WALLET_SECRET;    // base58 encoded private key

if (!RPC_ENDPOINT || !PRIVATE_KEY) {
  throw new Error("Please set PRIVATE_RPC_URL and WALLET_SECRET in config");
}

const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

async function getTokenBalance(mintAddress) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(mintAddress) }
    );

    if (tokenAccounts.value.length === 0) {
      logger.warn(`⚠️ No balance found for token ${mintAddress}`);
      return { amount: 0, decimals: 0 };
    }

    const tokenInfo = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return {
      amount: Number(tokenInfo.amount), // raw amount (smallest units)
      decimals: tokenInfo.decimals,
    };
  } catch (err) {
    logger.error("❌ Failed to fetch token balance:", err);
    return { amount: 0, decimals: 0 };
  }
}


module.exports = { getTokenBalance };