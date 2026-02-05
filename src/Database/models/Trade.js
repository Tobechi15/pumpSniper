const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema({
    tokenAddress: { type: String, required: true },
    reserve: {
        tokenReserve: { type: String },
        baseReserve: { type: String },
    },
    step: { type: Number, default: 0 },
    signature: { type: String },
    tokenName: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    openPrice: { type: Number },
    buyPrice: { type: Number, required: true },
    amountIn: { type: Number, required: true },
    amountOut: { type: Number, default: 0 },
    sellPrice: { type: Number },
    profitLoss: { type: Number },
    closedAt: { type: Date },
    status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    createdAt: { type: Date, default: Date.now },
});

const Trade = mongoose.model("Snipe", tradeSchema);

module.exports = Trade;