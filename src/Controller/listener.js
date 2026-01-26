const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const { logger } = require('../Utils/logger');

// ---------------- RPC QUEUE (Memory & Rate Limit Optimized) ----------------
class RpcQueue {
    constructor({ concurrency = 1, minDelay = 1200 }) { // Increased delay for public RPC safety
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

    clear() {
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            item.reject(new Error("Queue cleared due to rate limit"));
        }
    }

    async run() {
        if (this.active >= this.concurrency || isRateLimited()) return;
        const item = this.queue.shift();
        if (!item) return;

        this.active++;
        try {
            if (isRateLimited()) {
                item.reject(new Error("Rate limited"));
            } else {
                const result = await item.task();
                item.resolve(result);
            }
        } catch (e) {
            item.reject(e);
        } finally {
            this.active--;
            setTimeout(() => this.run(), this.minDelay);
        }
    }
}

const rpcQueue = new RpcQueue({ concurrency: 1, minDelay: 1200 });

// ---------------- CIRCUIT BREAKER ----------------
let rateLimitedUntil = 0;
function isRateLimited() {
    return Date.now() < rateLimitedUntil;
}

function triggerRateLimitPause(ms = 30000) {
    if (isRateLimited()) return; 
    rateLimitedUntil = Date.now() + ms;
    rpcQueue.clear(); 
    logger.warn(`!!! RPC 429 DETECTED !!! Cooling down for ${ms / 1000}s. Queue cleared.`);
}

// ---------------- TTL CACHE (Memory Friendly) ----------------
class TTLCache {
    constructor(ttl = 60000) { 
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
        if (this.map.size > 50) this.prune(); // Kept very small for 512MB RAM
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
        this.connection = new Connection(rpcUrl, { 
            wsEndpoint: wssUrl,
            disableRetryOnRateLimit: true, // Crucial: Stop hidden background memory-leak loops
            commitment: 'confirmed'
        });
        this.PUMP_MIGRATION_PROGRAM = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

        this.seen = new TTLCache(60000); 
        this.seenTokens = new TTLCache(60000);
    }

    async start() {
        logger.info("Monitoring Pump.fun graduations (Success Only Mode)...");

        this.connection.onLogs(
            this.PUMP_MIGRATION_PROGRAM,
            async (logs) => {
                // 1. SKIP FAILED TXS: Only proceed if logs.err is null (Success)
                // This stops 90% of the spam that causes 429s.
                if (logs.err !== null) return;

                if (isRateLimited()) return;

                try {
                    // 2. SPECIFIC LOG FILTER
                    const isActualMigrate = logs.logs.some(l => 
                        l.includes("Program log: Instruction: Migrate")
                    );
                    if (!isActualMigrate) return;

                    const signature = logs.signature;
                    if (this.seen.has(signature)) return;
                    this.seen.set(signature);

                    // 3. FETCH FULL TRANSACTION (Queued)
                    const tx = await rpcQueue.push(() =>
                        this.connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                        }).catch(err => {
                            if (err.message?.includes("429")) {
                                triggerRateLimitPause(45000); // Wait longer on 429
                            }
                            throw err; 
                        })
                    );

                    if (!tx || !tx.transaction) return;

                    // 4. EXTRACT TOKEN MINT
                    const accounts = tx.transaction.message.accountKeys;
                    let tokenMint = null;

                    for (let i = 0; i < accounts.length; i++) {
                        const pubkey = accounts[i].pubkey.toString();
                        // Pump.fun tokens always end with 'pump'
                        if (pubkey.endsWith('pump')) {
                            tokenMint = pubkey;
                            break;
                        }
                    }

                    if (tokenMint && !this.seenTokens.has(tokenMint)) {
                        this.seenTokens.set(tokenMint);
                        logger.info(`✅ GRADUATION CONFIRMED → ${tokenMint}`);
                        this.emit('graduated', tokenMint);
                    }

                    // 5. CRITICAL RAM CLEANUP: Explicitly drop large objects
                    tx.transaction = null;

                } catch (err) {
                    const msg = err.message || "";
                    if (!msg.includes("Queue cleared") && !msg.includes("Rate limited")) {
                        logger.warn(`Listener Error: ${msg.substring(0, 80)}`);
                    }
                }
            },
            'confirmed'
        );
    }
}

module.exports = GraduationDetector;