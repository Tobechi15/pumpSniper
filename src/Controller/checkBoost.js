const axios = require("axios");
const EventEmitter = require("events");

class DexBoostQueue extends EventEmitter {
    constructor(options = {}) {
        super();

        this.intervalMs = options.intervalMs || 6000;
        this.concurrency = options.concurrency || 2;
        this.chainId = options.chainId || "bsc";

        // 2 hours hard timeout (ms)
        this.maxLifetimeMs = options.maxLifetimeMs || 2 * 60 * 60 * 1000;

        this.queue = [];
        this.activeWorkers = 0;
        this.running = false;
    }

    addToken(tokenAddress) {
        if (this.queue.find(t => t.tokenAddress === tokenAddress)) return;

        this.queue.push({
            tokenAddress,
            createdAt: Date.now(),
            lastChecked: 0,
            boosted: false,
            expired: false
        });
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._processQueue();
    }

    stop() {
        this.running = false;
    }

    async _processQueue() {
        if (!this.running) return;

        // Remove expired tokens before processing
        this._expireTokens();

        while (this.activeWorkers < this.concurrency) {
            const token = this._getNextToken();
            if (!token) break;

            this._checkToken(token);
        }

        setTimeout(() => this._processQueue(), 1000);
    }

    _expireTokens() {
        const now = Date.now();

        this.queue = this.queue.filter(token => {
            if (token.boosted) return false;

            if (now - token.createdAt >= this.maxLifetimeMs) {
                token.expired = true;

                this.emit("expired", {
                    tokenAddress: token.tokenAddress,
                    lifetimeMs: now - token.createdAt
                });

                return false; // remove from queue
            }

            return true;
        });
    }

    _getNextToken() {
        const now = Date.now();

        return this.queue.find(
            t =>
                !t.boosted &&
                !t.expired &&
                now - t.lastChecked >= this.intervalMs
        );
    }

    async _checkToken(token) {
        this.activeWorkers++;
        token.lastChecked = Date.now();

        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${token.tokenAddress}`;
            const { data } = await axios.get(url, { timeout: 8000 });

            const pair = data?.pairs?.find(p => p.chainId === this.chainId);
            const boosted = Boolean(pair?.boosts?.active);

            if (boosted) {
                token.boosted = true;

                this.emit("boosted", {
                    tokenAddress: token.tokenAddress,
                    dexId: pair.dexId,
                    pairAddress: pair.pairAddress,
                    boostData: pair.boosts
                });
            }

        } catch (err) {
            this.emit("error", {
                tokenAddress: token.tokenAddress,
                message: err.message
            });
        } finally {
            this.activeWorkers--;
        }
    }
}

module.exports = DexBoostQueue;
