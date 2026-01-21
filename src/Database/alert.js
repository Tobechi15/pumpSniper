const axios = require('axios');
const { config } = require('../Utils/config')

const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = config.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(message) {
    try {
        for (const chatId of TELEGRAM_CHAT_ID) {
            await axios.post(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                {
                    chat_id: chatId,
                    text: message,
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );
        }
    } catch (error) {
        console.error('Telegram API error:', error);
    }
}

module.exports = sendTelegramMessage;
