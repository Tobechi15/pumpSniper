// detector.js
const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const { logger } = require('../Utils/logger');

class GraduationDetector extends EventEmitter {
    constructor(rpcUrl, wssUrl) {
        super();
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl });
        this.PUMP_MIGRATION_PROGRAM = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
        this.seenSignatures = new Set();
    }

    markSeen(signature) {
        if (this.seenSignatures.has(signature)) return false;
        this.seenSignatures.add(signature);
        setTimeout(() => this.seenSignatures.delete(signature), 1000 * 60 * 5);
        return true;
    }

    async start() {
        logger.info("Monitoring Pump.fun graduations...");

        this.connection.onLogs(
            this.PUMP_MIGRATION_PROGRAM,
            async (logs) => {
                try {
                    if (!this.markSeen(logs.signature)) return;
                    if (!logs.logs.some(log => log.includes("Migrate"))) return;

                    const signature = logs.signature;

                    const tx = await this.connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    });

                    if (!tx) return;

                    // Extract token mint from transaction accounts
                    const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
                    const tokenMint = accounts.find(addr => addr.endsWith('pump'));

                    if (!tokenMint) return;

                    logger.info(`Signature: ${signature}`);

                    // Emit event to external listener
                    this.emit('graduated', tokenMint);

                } catch (err) {
                    // logger.warn(`Error processing graduation log: ${err.message}`);
                    // Often occurs if transaction isn't fully indexed yet
                }
            },
            'confirmed'
        );
    }
}

module.exports = GraduationDetector;