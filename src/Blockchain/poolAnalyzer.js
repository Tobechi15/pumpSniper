// poolAnalyzer.js
const { Connection, PublicKey } = require('@solana/web3.js');
const { logger } = require('../Utils/logger');

class PoolAnalyzer {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  }

  // Get token mint info (supply + decimals)
  async getMintInfo(mintAddress) {
    const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const parsed = mintInfo.value?.data?.parsed?.info;

    if (!parsed) throw new Error(`Mint info not found for ${mintAddress}`);

    return {
      supply: Number(parsed.supply),
      decimals: parsed.decimals,
    };
  }

  // Get reserve balance of a token account
  async getReserveBalance(tokenAccount) {
    const balanceInfo = await this.connection.getTokenAccountBalance(new PublicKey(tokenAccount));
    return {
      amount: Number(balanceInfo.value.amount),  // raw integer
      decimals: balanceInfo.value.decimals,
    };
  }

  // Derive price + liquidity from pool reserves
  async analyzePool(token0Mint, token1Mint, token0Account, token1Account, referenceToken = "USDC") {
    try {

      const token = token0Mint;
      const base = token1Mint;

      const tokenReserve = token0Account;
      const baseReserve = token1Account;

      // fetch reserves
      const [reserve0, reserve1] = await Promise.all([
        this.getReserveBalance(tokenReserve),
        this.getReserveBalance(baseReserve),
      ]);

      // fetch mint info (supply/decimals)
      const [mint0, mint1] = await Promise.all([
        this.getMintInfo(token),
        this.getMintInfo(base),
      ]);

      // normalize reserves
      const normReserve0 = reserve0.amount / (10 ** reserve0.decimals);
      const normReserve1 = reserve1.amount / (10 ** reserve1.decimals);

      // price calculation
      const price0 = normReserve1 / normReserve0; // price of token0 in token1
      const price1 = normReserve0 / normReserve1; // price of token1 in token0

      // market cap (example for token0)
      const circulating0 = mint0.supply / (10 ** mint0.decimals);
      const marketCap0 = circulating0 * price0;

      return {
        reserves: {
          [token]: normReserve0,
          [base]: normReserve1,
        },
        prices: {
          [`${token}_in_${base}`]: price0,
          [`${base}_in_${token}`]: price1,
        },
        liquidity: {
          [`${token}`]: normReserve0 * price0,
          [`${base}`]: normReserve1 * price1,
        },
        marketCaps: {
          [token]: marketCap0,
        }
      };
    } catch (e) {
      console.error("[PoolAnalyzer ERROR]", e);
      return null;
    }
  }
}

module.exports = PoolAnalyzer;
