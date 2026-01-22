// audit.js
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const { config } = require('../Utils/config');
const { logger } = require('../Utils/logger');

/* -------------------- CONSTANTS -------------------- */

const RPC_ENDPOINT = config.PUBLIC_RPC_URL;

const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://infura-ipfs.io/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://gateway.ipfs.io/ipfs/',
    'https://ipfs.infura.io/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://pinata.gateway.pinata.cloud/ipfs/'
];

const AXIOS_CONFIG = {
    timeout: 10_000,
    headers: {
        Accept: '*/*', // allow any content type
        'User-Agent': 'Mozilla/5.0'
    }
};


/* -------------------- SINGLETON RPC -------------------- */

const connection = new Connection(RPC_ENDPOINT, {
    commitment: 'confirmed'
});

/* -------------------- METADATA HELPERS -------------------- */

const isIpfsUri = (uri) =>
    uri.startsWith('ipfs://') || uri.includes('/ipfs/');

const extractCid = (uri) => {
    if (!uri) return null;

    if (uri.startsWith('ipfs://')) {
        return uri.replace('ipfs://', '').split('/')[0];
    }

    const match = uri.match(/ipfs\/([^/?#]+)/);
    return match ? match[1] : null;
};

const buildGatewayUrls = (cid) =>
    IPFS_GATEWAYS.map((g) => `${g}${cid}`);

const fetchIpfsJsonWithFallback = async (uri) => {
    const cid = extractCid(uri);
    if (!cid) throw new Error('Invalid IPFS URI');

    let lastError;

    for (const url of buildGatewayUrls(cid)) {
        try {
            const res = await axios.get(url, {
                timeout: 10_000,
                responseType: 'text'
            });

            return JSON.parse(res.data);
        } catch (err) {
            if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                continue;
            }
            lastError = err;
        }
    }

    throw new Error(lastError?.message || 'All IPFS gateways failed');
};

const fetchHttpJson = async (url) => {
    const { data } = await axios.get(url, AXIOS_CONFIG);
    return data;
};

const fetchMetadata = async (uri) => {
    if (!uri) return null;

    if (isIpfsUri(uri)) {
        return fetchIpfsJsonWithFallback(uri);
    }

    // Centralized HTTPS metadata (e.g. uxento.io)
    return fetchHttpJson(uri);
};

/* -------------------- MAIN METADATA FETCH -------------------- */

async function GetMetaData(mint) {
    try {
        const mintKey = new PublicKey(mint);

        const acc = await connection.getParsedAccountInfo(mintKey);
        const info = acc.value?.data?.parsed?.info;

        if (!info) {
            logger.warn(`No mint data found for ${mint}`);
            return null;
        }

        /* ---------- Supply & Authorities ---------- */

        const decimals = Number(info.decimals);
        const supply =
            Number(BigInt(info.supply)) / Math.pow(10, decimals);

        const mintOff = !info.mintAuthority;
        const freezeOff = !info.freezeAuthority;

        /* ---------- Token Metadata Extension ---------- */

        const metadataExt = info.extensions?.find(
            (ext) => ext.extension === 'tokenMetadata'
        );

        if (!metadataExt?.state) {
            logger.warn(`No tokenMetadata extension for ${mint}`);
            return {
                supply,
                decimals,
                mintOff,
                freezeOff
            };
        }

        const { name, symbol, uri } = metadataExt.state;

        /* ---------- Off-chain Metadata ---------- */

        let twitterHandle = null;

        if (uri) {
            try {
                const json = await fetchMetadata(uri);
                twitterHandle = json?.twitter || null;
            } catch (err) {
                logger.warn(`Metadata fetch failed: ${err.message}`);
            }
        }

        return {
            name,
            symbol,
            uri,
            twitterHandle,
            supply,
            decimals,
            mintOff,
            freezeOff
        };
    } catch (error) {
        logger.error(`GetMetaData error for ${mint}:`, error);
        return null;
    }
}

module.exports = { GetMetaData };
