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
import {IPowerOracleStorage} from "../storage/interface";

const _ = require('lodash');
const config = require('./config');
const utils = require('../utils');

module.exports = async (web3, storage, tgBot) => {
    const app = new PowerOracleApp(web3, storage, tgBot);
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
    storage: IPowerOracleStorage;
    tgBot: IPowerOracleTgBot;

    lastMaxGasPriceErrorTime;

    constructor(web3, storage, tgBot) {
        this.powerOracleWeb3 = web3;
        this.storage = storage;
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
        const poWeb3 = this.powerOracleWeb3;
        const timestamp = await poWeb3.getTimestamp();
        console.log('checkAndAction', poWeb3.activeTxTimestamp, 'timestamp', timestamp, 'delay', poWeb3.getDelayUntilNewTransaction());
        if(poWeb3.activeTxTimestamp && timestamp - poWeb3.activeTxTimestamp < poWeb3.getDelayUntilNewTransaction()) {
            return;
        }
        return (await poWeb3.isCurrentAccountReporter()) ? poWeb3.checkAndActionAsReporter() : poWeb3.checkAndActionAsSlasher();
    }

    handleError(error) {
        if(_.includes(error.message, "Max Gas Price")) {
            const curTime = Math.round(new Date().getTime() / 1000);
            if(!this.lastMaxGasPriceErrorTime || curTime - this.lastMaxGasPriceErrorTime >= 60 * 60) {
                this.lastMaxGasPriceErrorTime = curTime;
                return this.tgBot.sendMessageToAdmin(`⚠️ ${error.message}`);
            }
        }
        console.error('handleError', error);
        if(error && error.message && (_.includes(error.message, 'Invalid JSON RPC') || _.includes(error.message, 'request failed or timed out'))) {
            return this.tgBot.sendMessageToAdmin(`⚠️ Data fetching error: RPC endpoint Time-out\n\nWe recommend to place more reliable Ethereum RPC endpoint to <code>RPC_SERVER</code> variable in bot starting command if this error appears too often.`);
        }
        const stackArr = error.stack.split("\n");
        let appStack = stackArr
            .filter(stackStr => !_.includes(stackStr, 'node_modules')  && !_.includes(stackStr, error.message))
            .map(stackStr => _.trim(stackStr, " "))
            .join("\n");
        // console.log('error.stack.split("\\n")', error.stack.split("\n"));
        return this.tgBot.sendMessageToAdmin(`❌  Error in bot:\n\n<pre>${utils.tgClear(error.message)}</pre>\n\n<pre>${utils.tgClear(appStack)}</pre>`);
    }

    async messageAboutNewTx(hash) {
        await this.powerOracleWeb3.parseTxData(hash).then(async parsedTx => {
            if(!parsedTx) {
                return;
            }
            let prefix;
            if (parsedTx.status === 'confirmed') {
                prefix = `↗️ Tx sent`;
            } else if(parsedTx.status === 'reverted') {
                prefix = `❗️ Tx reverted`;
            } else if(parsedTx.status === 'pending') {
                prefix = `🚼 Tx pending`;
            } else if(parsedTx.status === 'not_found') {
                return this.tgBot.sendMessageToAdmin(`🛑 Tx not found ${this.powerOracleWeb3.getTxLink(hash)}`);
            }

            let footer = '';
            if (parsedTx.ethSpent && parsedTx.weiSpent) {
                const totalWeiSpent = await this.storage.increaseBnValue('wei_spent', parsedTx.weiSpent);
                footer += `\nETH spent: <code>${utils.roundNumber(parsedTx.ethSpent, 4)}</code> / <code>${utils.weiToEther(totalWeiSpent, 4)}</code> ETH`;
                const ethBalance = await this.powerOracleWeb3.getEthBalance(this.powerOracleWeb3.getCurrentPokerAddress());
                footer += `\nETH balance: <code>${utils.roundNumber(ethBalance, 4)}</code> ETH\n`;
            }
            const rewardEvents = parsedTx.events.filter(e => e && e.name === 'RewardUser');
            rewardEvents.forEach(event => {
                const totalReward = event.values.compensationEvaluationCVP + event.values.bonusCVP;
                footer += event.values.bonusPlan.toString() === '1' ? `\nPrice report reward:` : `\nSlasher update reward:`;
                footer += ` <code>${utils.roundNumber(totalReward, 2)}</code> CVP`;
            });

            const totalReward = utils.roundNumber(await this.powerOracleWeb3.getPendingReward(), 2);
            footer += `\nPending reward: <code>${totalReward}</code> CVP`;

            return this.tgBot.sendMessageToAdmin(
                `${prefix} ${this.powerOracleWeb3.getTxLink(hash)}\n\n✏️ Action: <code>${parsedTx.methodName}</code>`
                + (footer ? ('\n' + footer) : '')
            );

        }).catch((e) => {
            console.error('handleTx', hash, e);
        });
    }

    async messageAboutLowBalance() {
        const ethBalance = await this.powerOracleWeb3.getEthBalance(this.powerOracleWeb3.getCurrentPokerAddress());
        if(ethBalance <= config.warnBalanceLowerThan) {
            await this.tgBot.sendMessageToAdmin(`⚠️ Low balance: <code>${ethBalance}</code> ETH\n\nReporter address: <code>${this.powerOracleWeb3.getCurrentPokerAddress()}</code>`);
        }
    }

    async handleTx(hash) {
        await this.messageAboutNewTx(hash).catch(e => {
            console.error('messageAboutNewTx', e);
        })

        if(config.warnBalanceLowerThan) {
            await this.messageAboutLowBalance();
        }
    }
}
