const {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
    createCloseAccountInstruction,
    createBurnInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { config } = require("../Utils/config");
const bs58 = require("bs58").default;

const connection = new Connection(config.PRIVATE_RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(config.WALLET_SECRET));

/**
 * Enhanced logic to find the ATA from a transaction signature.
 * Works for both PumpSwap internal trades and Raydium migrations.
 */
async function getDestinationAccount(txSignature, type) {
    try {
        const tx = await connection.getTransaction(txSignature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!tx) throw new Error("Transaction not found");

        const { meta, transaction } = tx;
        if (!meta?.postTokenBalances) throw new Error("No token balances in metadata");

        // Filter for accounts owned by our wallet
        const walletAddress = wallet.publicKey.toBase58();
        
        // Strategy: Find the account where our wallet's balance changed
        for (const post of meta.postTokenBalances) {
            if (post.owner === walletAddress) {
                const pre = meta.preTokenBalances?.find(p => p.accountIndex === post.accountIndex);
                const postAmt = BigInt(post.uiTokenAmount.amount);
                const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;

                // For a 'sell', we look for the account where balance dropped to 0 or near 0
                if (type === "sell" && preAmt > postAmt) {
                    const ata = transaction.message.staticAccountKeys[post.accountIndex];
                    return ata;
                }
                // For a 'buy', we look for the new account created
                if (type === "buy" && postAmt > preAmt) {
                    const ata = transaction.message.staticAccountKeys[post.accountIndex];
                    return ata;
                }
            }
        }
        throw new Error("Could not find matching token account for this wallet in TX.");
    } catch (err) {
        console.error("🔍 Account Discovery Error:", err.message);
        return null;
    }
}

const burner = async (signature, type = "sell") => {
    try {
        const ataAddress = await getDestinationAccount(signature, type);
        if (!ataAddress) return;

        const TOKEN_ACCOUNT = new PublicKey(ataAddress);
        const accountInfo = await connection.getParsedAccountInfo(TOKEN_ACCOUNT);
        
        if (!accountInfo.value) {
            console.log("ℹ️ Account already closed or doesn't exist.");
            return;
        }

        const parsedData = accountInfo.value.data.parsed.info;
        const mint = new PublicKey(parsedData.mint);
        const rawAmount = parsedData.tokenAmount.amount;
        const uiAmount = parsedData.tokenAmount.uiAmount;

        // Auto-detect Program ID (Token vs Token-2022)
        const programId = accountInfo.value.owner; 
        console.log(`🚀 Target Mint: ${mint.toBase58()}`);
        console.log(`📋 Program ID: ${programId.toBase58()}`);
        console.log(`💰 Remaining Dust: ${uiAmount}`);

        const instructions = [];

        // 1. Burn Instruction (Required if balance > 0)
        if (BigInt(rawAmount) > 0n) {
            console.log(`🔥 Burning ${uiAmount} remaining tokens...`);
            instructions.push(
                createBurnInstruction(
                    TOKEN_ACCOUNT,
                    mint,
                    wallet.publicKey,
                    BigInt(rawAmount),
                    [],
                    programId
                )
            );
        }

        // 2. Close Account Instruction (Reclaims ~0.002 SOL)
        console.log("🔓 Reclaiming rent...");
        instructions.push(
            createCloseAccountInstruction(
                TOKEN_ACCOUNT,
                wallet.publicKey, // SOL goes here
                wallet.publicKey, // Authority
                [],
                programId
            )
        );

        const tx = new Transaction().add(...instructions);
        
        // Update blockhash for speed
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
        console.log(`✅ Rent Collected! Refund received in wallet.`);
        console.log(`🔗 Tx: https://solscan.io/tx/${sig}`);
        
        return sig;
    } catch (err) {
        console.error("❌ Burner Failed:", err.message);
    }
};

module.exports = { burner };