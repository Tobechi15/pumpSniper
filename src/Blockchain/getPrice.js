const { Connection, PublicKey } = require('@solana/web3.js');
const { config } = require('../Utils/config');

const rpcUrl = config.PUBLIC_RPC_URL;
const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

/**
 * Get reserve balance and decimals of a token account
 */
const getReserveBalance = async (tokenAccount) => {
  const balanceInfo = await connection.getTokenAccountBalance(new PublicKey(tokenAccount));
  if (!balanceInfo || !balanceInfo.value) return { amount: 0, decimals: 0 };

  return {
    amount: Number(balanceInfo.value.amount),  // raw integer
    decimals: balanceInfo.value.decimals,
  };
};

/**
 * Get price of tokenReserve in terms of baseReserve
 */
const getPrice = async (tokenReserve, baseReserve) => {
  const [reserve0, reserve1] = await Promise.all([
    getReserveBalance(tokenReserve),
    getReserveBalance(baseReserve),
  ]);

  if (reserve0.amount === 0 || reserve1.amount === 0) {
    return 0; // avoid division by zero
  }

  // normalize reserves
  const normReserve0 = reserve0.amount / (10 ** reserve0.decimals);
  const normReserve1 = reserve1.amount / (10 ** reserve1.decimals);

  // price of 1 tokenReserve in baseReserve
  const price = normReserve1 / normReserve0;

  return price;
};

module.exports = { getPrice };
