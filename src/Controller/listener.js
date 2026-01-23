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

    push(task) {
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

// ---------------- TTL CACHE (memory-friendly) ----------------
class TTLCache {
    constructor(ttl = 600_000) { // 10 minutes
        this.ttl = ttl;
        this.map = new Map();
    }

    has(key) {
        const now = Date.now();
        const t = this.map.get(key);
        if (!t) return false;
        if (now - t > this.ttl) {
            this.map.delete(key);
            return false;
        }
        return true;
    }

    set(key) {
        this.map.set(key, Date.now());
        this.prune();
    }

    prune() {
        const now = Date.now();
        for (const [k, t] of this.map.entries()) {
            if (now - t > this.ttl) this.map.delete(k);
        }
    }
}

// ---------------- DETECTOR ----------------
class GraduationDetector extends EventEmitter {
    constructor(rpcUrl, wssUrl) {
        super();
        this.connection = new Connection(rpcUrl, { wsEndpoint: wssUrl });
        this.PUMP_MIGRATION_PROGRAM = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

        this.seen = new TTLCache(1 * 60 * 1000); // 1min TTL
        this.seenTokens = new TTLCache(1 * 60 * 1000); // 1min TTL
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

                    if (this.seen.has(signature)) return;
                    this.seen.set(signature);

                    const tx = await rpcQueue.push(() =>
                        this.connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        })
                    );

                    if (!tx) return;

                    // avoid creating intermediate arrays
                    const accounts = tx.transaction.message.accountKeys;
                    let tokenMint;
                    for (let i = 0; i < accounts.length; i++) {
                        const pubkey = accounts[i].pubkey.toString();
                        if (pubkey.endsWith('pump')) {
                            tokenMint = pubkey;
                            break;
                        }
                    }
                    if (!tokenMint) return;

                    if (this.seenTokens.has(tokenMint)) return;
                    this.seenTokens.set(tokenMint);

                    logger.info(`Signature: ${signature}`);
                    this.emit('graduated', tokenMint);

                    // explicitly free memory
                    tx.transaction = null;

                } catch (err) {
                    if (err.message?.includes("429")) {
                        triggerRateLimitPause(30_000);
                    }
                    logger.warn(`Error processing graduation log: ${err.message}`);
                }
            },
            'confirmed'
        );
    }
}

module.exports = GraduationDetector;
