// detector.js
const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const { logger } = require('../Utils/logger');


// ---------------- RPC QUEUE ----------------
class RpcQueue {
    constructor({ concurrency = 1, minDelay = 500 }) {
        this.queue = [];
        this.active = 0;
        this.concurrency = concurrency;
        this.minDelay = minDelay;
    }

    async push(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.run();
        });
    }

    async run() {
        if (this.active >= this.concurrency) return;
        const item = this.queue.shift();
        if (!item) return;

        this.active++;
        try {
            const result = await item.task();
            item.resolve(result);
        } catch (e) {
            item.reject(e);
        } finally {
            this.active--;
            setTimeout(() => this.run(), this.minDelay);
        }
    }
}

const rpcQueue = new RpcQueue({ concurrency: 1, minDelay: 600 });


// ---------------- CIRCUIT BREAKER ----------------
let rateLimitedUntil = 0;
function isRateLimited() {
    return Date.now() < rateLimitedUntil;
}
function triggerRateLimitPause(ms = 20000) {
    rateLimitedUntil = Date.now() + ms;
    logger.warn(`RPC rate limited. Cooling down for ${ms / 1000}s`);
}



// ---------------- DETECTOR ----------------
class GraduationDetector extends EventEmitter {
    constructor(rpcUrl, wssUrl) {
        super();
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl });
        this.PUMP_MIGRATION_PROGRAM = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

        this.seen = new Map();
        this.ttl = 1000 * 60 * 10; // 10 minutes
    }

    markSeen(key) {
        const now = Date.now();
        for (const [k, t] of this.seen.entries()) {
            if (now - t > this.ttl) this.seen.delete(k);
        }
        if (this.seen.has(key)) return false;
        this.seen.set(key, now);
        return true;
    }

    async start() {
        logger.info("Monitoring Pump.fun graduations...");

        this.connection.onLogs(
            this.PUMP_MIGRATION_PROGRAM,
            async (logs) => {
                try {
                    if (isRateLimited()) return;

                    if (!logs.logs.some(l => l.includes("Migrate"))) return;

                    const signature = logs.signature;

                    // Deduplicate by signature only first
                    if (!this.markSeen(signature)) return;

                    // Queue RPC request
                    const tx = await rpcQueue.push(() =>
                        this.connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        })
                    );

                    if (!tx) return;

                    const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
                    const tokenMint = accounts.find(a => a.endsWith('pump'));
                    if (!tokenMint) return;

                    // Deduplicate by signature + mint (extra safety)
                    const dedupeKey = `${signature}-${tokenMint}`;
                    if (!this.markSeen(dedupeKey)) return;

                    logger.info(`Signature: ${signature}`);
                    logger.info(`TRIGGER: Token graduated → ${tokenMint}`);

                    this.emit('graduated', tokenMint);

                } catch (err) {
                    if (err.message?.includes("429")) {
                        triggerRateLimitPause(30000);
                    }
                    logger.warn(`Error processing graduation log: ${err.message}`);
                }
            },
            'confirmed'
        );
    }
}

module.exports = GraduationDetector;
