/*
 * https://powerpool.finance/
 *
 *           wrrrw r wrr
 *          ppwr rrr wppr0       prwwwrp                                 prwwwrp                   wr0
 *         rr 0rrrwrrprpwp0      pp   pr  prrrr0 pp   0r  prrrr0  0rwrrr pp   pr  prrrr0  prrrr0    r0
 *         rrp pr   wr00rrp      prwww0  pp   wr pp w00r prwwwpr  0rw    prwww0  pp   wr pp   wr    r0
 *         r0rprprwrrrp pr0      pp      wr   pr pp rwwr wr       0r     pp      wr   pr wr   pr    r0
 *          prwr wrr0wpwr        00        www0   0w0ww    www0   0w     00        www0    www0   0www0
 *           wrr ww0rrrr
 */

import {IPowerOracleTgBot} from "./interface";

const config = require('./config');
const telegramBot = require('node-telegram-bot-api');

module.exports = async () => {
    const app = new PowerOracleTgBot();
    app.init();
    return app;
};

class PowerOracleTgBot implements IPowerOracleTgBot {
    bot;

    constructor() {}

    init() {
        if(!this.isReady()) {
            return;
        }
        this.bot = new telegramBot(config.botKey, {filepath: false});
        this.bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            this.bot.sendMessage(chatId, "Hello, this is a PowerPool oracle bot!", {parseMode: 'HTML'});
        });
    }

    isReady() {
        return config.botKey && config.adminId;
    }

    sendMessageToAdmin(messageText) {
        if(!this.isReady()) {
            return;
        }
        console.log('sendMessageToAdmin', messageText);
        return this.bot.sendMessage(config.adminId, messageText, {parse_mode: 'HTML'});
    }
}
