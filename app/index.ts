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

import {IPowerOracleWeb3} from "../web3/interface";
import {IPowerOracleTgBot} from "../tgBot/interface";
import {IPowerOracleApp} from "./interface";

const _ = require('lodash');
const config = require('./config');

module.exports = async (web3, tgBot) => {
    const app = new PowerOracleApp(web3, tgBot);
    app.init();
    require('./cron')(app);
    return app;
};

//TODO:
// notify on slashing
// notify on pending too long transaction
// notify on revert
// notify on became reporter, slasher

class PowerOracleApp implements IPowerOracleApp {
    powerOracleWeb3: IPowerOracleWeb3;
    tgBot: IPowerOracleTgBot;

    constructor(web3, tgBot) {
        this.powerOracleWeb3 = web3;
        this.tgBot = tgBot;
    }

    init() {
        if(!this.powerOracleWeb3.currentUserId) {
            throw new Error('User id not found for poker key');
        }
        this.powerOracleWeb3.onError((e) => {
            this.handleError(e);
        });
        this.powerOracleWeb3.onTransaction((hash) => {
            this.handleTx(hash);
        });
    }

    async checkAndActionSafe() {
        return this.checkAndAction().catch(e => {
            this.handleError(e);
        });
    }

    async checkAndAction() {
        console.log('checkAndAction');
        const poWeb3 = this.powerOracleWeb3;
        const timestamp = poWeb3.getTimestamp();
        if(poWeb3.activeTxTimestamp && timestamp - poWeb3.activeTxTimestamp < poWeb3.getDelayUntilNewTransaction()) {
            return;
        }
        return (await poWeb3.isCurrentAccountReporter()) ? poWeb3.checkAndActionAsReporter() : poWeb3.checkAndActionAsSlasher();
    }

    handleError(error) {
        // console.log('error.stack.split("\\n")', error.stack.split("\n"));
        return this.tgBot.sendMessageToAdmin(`Error in bot:\n<code>${error.message}</code>\nIn <code>${_.trim(error.stack.split("\n")[1], " ")}</code>`)
    }

    async handleTx(hash) {
        if(config.warnBalanceLowerThan) {
            const ethBalance = await this.powerOracleWeb3.getEthBalance(this.powerOracleWeb3.getCurrentPokerAddress());
            if(ethBalance <= config.warnBalanceLowerThan) {
                await this.tgBot.sendMessageToAdmin(`Low balance:\n<code>${ethBalance}</code> ETH`);
            }
        }
    }
}
