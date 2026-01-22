// detector.js
const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const { logger } = require('../Utils/logger');

class GraduationDetector extends EventEmitter {
    constructor(rpcUrl, wssUrl) {
        super();
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl });
        this.PUMP_MIGRATION_PROGRAM = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

        // Map to track seen signatures with timestamp
        this.seenSignatures = new Map();
        this.ttl = 1000 * 60 * 5; // 5 minutes
    }

    markSeen(signature) {
        const now = Date.now();

        // Clean up expired entries
        for (const [sig, time] of this.seenSignatures.entries()) {
            if (now - time > this.ttl) this.seenSignatures.delete(sig);
        }

        // If already seen, skip
        if (this.seenSignatures.has(signature)) return false;

        // Mark as seen
        this.seenSignatures.set(signature, now);
        return true;
    }

    async start() {
        logger.info("Monitoring Pump.fun graduations...");

        this.connection.onLogs(
            this.PUMP_MIGRATION_PROGRAM,
            async (logs) => {
                try {
                    // Only proceed if signature has not been seen recently
                    if (!this.markSeen(logs.signature)) return;

                    // Skip logs without "Migrate"
                    if (!logs.logs.some(log => log.includes("Migrate"))) return;

                    const signature = logs.signature;

                    // Fetch transaction details
                    const tx = await this.connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    });

                    if (!tx) return;

                    // Extract token mint from transaction accounts
                    const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
                    const tokenMint = accounts.find(addr => addr.endsWith('pump'));

                    if (!tokenMint) return;

                    // Log once per signature
                    logger.info(`Signature: ${signature}`);
                    logger.info(`TRIGGER: Token graduated → ${tokenMint}`);

                    // Emit event to external listener
                    this.emit('graduated', tokenMint);

                } catch (err) {
                    logger.warn(`Error processing graduation log: ${err.message}`);
                }
            },
            'confirmed'
        );
    }
}

module.exports = GraduationDetector;