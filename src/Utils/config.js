require("dotenv").config();

const config = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  MONGO_URI: process.env.MONGO_URI,

  PUBLIC_WS_URL: process.env.PUBLIC_WS_URL,
  PUBLIC_RPC_URL: process.env.PUBLIC_RPC_URL,
  X_ACCOUNTS_JSON: process.env.ACCOUNTS_JSON,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WALLET_SECRET: process.env.WALLET_PRIVATE_KEY,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID.split(","),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  JUPITER_API_KEY: process.env.JUPITER_API_KEY,



  PRIVATE_RPC_URL: process.env.PRIVATE_RPC_URL,
  PORT: process.env.PORT || 5000,

  WALLET_ADDRESS: process.env.WALLET_ADDRESS,
  PRICE_CHANGE_THRESHOLD: process.env.PRICE_CHANGE_THRESHOLD ? parseFloat(process.env.PRICE_CHANGE_THRESHOLD) : 100, // Default to 100%
  PRICE_CHANGE_STOP: process.env.PRICE_CHANGE_STOP ? parseFloat(process.env.PRICE_CHANGE_STOP) : -50,
}

module.exports = { config }