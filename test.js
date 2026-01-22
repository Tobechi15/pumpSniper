const {GetMetaData} = require('./src/Blockchain/metaData');
const {offChainAnalyze} = require('./src/Controller/offChainAna')

// async function test() {
//     const mintAddress = "G76sR4CyukQhTTtt9u3daDQogwciUtF6bYJWgHGVpump"; 
//     const rpcEndpoint = "https://api.mainnet-beta.solana.com"; // Replace with your RPC endpoint

//     const metadata = await GetMetaData(mintAddress);
//     console.log("Token Metadata:", metadata);
// }

// test();

async function test() {
    const link = "https://x.com/WhiteHouse/status/2013811528680485252?s=20"
    const data = await offChainAnalyze(link);
    console.log('scrapped data:', data)
}
test()

// const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
// const { PumpFunSDK } = require("@pump-fun/pump-swap-sdk");
// const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");
// const bs58 = require("bs58").default;
// const { config } = require("../Utils/config");
// const { logger } = require("../Utils/logger.js");

// const RPC_ENDPOINT = config.PRIVATE_RPC_URL;
// const PRIVATE_KEY = config.WALLET_SECRET;

// // 1. Setup Connection and Wallet
// const connection = new Connection(RPC_ENDPOINT, "confirmed");
// const walletKeyPair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// // 2. Initialize SDK
// // We wrap the wallet in an Anchor-compatible Wallet object
// const provider = new AnchorProvider(connection, new Wallet(walletKeyPair), {
//   commitment: "confirmed",
// });
// const sdk = new PumpFunSDK(provider);

// /**
//  * Executes a Buy on Pump.fun
//  * @param {string} mintAddress - The contract address of the token
//  * @param {bigint} solAmount - Amount of SOL to spend (in Lamports)
//  * @param {bigint} slippageBasisPoints - Slippage (e.g., 500 for 5%)
//  */
// async function executeBuy(mintAddress, solAmount, slippageBasisPoints = 500n) {
//   try {
//     const mint = new PublicKey(mintAddress);
//     const buyer = walletKeyPair.publicKey;

//     logger.info(`🔄 Initiating Pump.fun buy for ${mintAddress}...`);

//     // The SDK handles the bonding curve math and transaction creation
//     const buyResults = await sdk.buy(
//       walletKeyPair,      // The Signer
//       mint,               // Token Mint
//       solAmount,          // Amount in Lamports (1 SOL = 1,000,000,000)
//       slippageBasisPoints, 
//       {
//         unitLimit: 250000,
//         unitPrice: 250000, // Priority fee (microLamports)
//       }
//     );

//     if (buyResults.success) {
//       logger.info(`✅ Buy Successful!`);
//       logger.info(`https://solscan.io/tx/${buyResults.signature}`);
//       return buyResults;
//     } else {
//       logger.error("❌ Buy failed during execution");
//       return null;
//     }
//   } catch (err) {
//     logger.error("❌ Error executing Pump.fun buy:", err.message || err);
//     return null;
//   }
// }

// module.exports = { executeBuy };

// const { offChainAnalyze } = require('./src/Controller/offChainAna');

// async function test() {
//     const twitterLink = "https://x.com/degn34"; // Replace with a valid Twitter link
//     const analysis = await offChainAnalyze(twitterLink);
//     console.log("Off-Chain Analysis Result:", analysis);
// }

// test();