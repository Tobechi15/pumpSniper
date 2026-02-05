const Trade  = require('./models/Trade');
// ---------- Helpers ----------
const pendingTransactions = async () => {
    // Fetch tokens from DB that are not sold
    const trades = await Trade.find({ status: "pending" });
    return trades.map(trade => ({
        id: trade._id.toString(),
        token_symbol: trade.tokenSymbol,
        token_address: trade.tokenAddress,
        token_reserve: trade.reserve,
        pair_address: trade.pairAddress,
        open_price: trade.openPrice,
        step: trade.step,
        approved: trade.approved,
        buy_price: trade.buyPrice,
        status: trade.status,
        created_at: trade.createdAt,
    }));
}
const transactionHistory = async () => {
    // Fetch tokens from DB that are not sold
    const history = await Trade.find({ status: { $in: ["completed", "failed"] } });;
    return history.map(trade => ({
        id: trade._id.toString(),
        token_symbol: trade.tokenSymbol,
        token_address: trade.tokenAddress,
        pair_address: trade.pairAddress,
        amount_in: trade.amountIn,
        buy_price: trade.buyPrice,
        sell_price: trade.sellPrice,
        profit_loss: trade.profitLoss,
        status: trade.status,
        created_at: trade.createdAt,
    }));
}
module.exports = { pendingTransactions, transactionHistory };