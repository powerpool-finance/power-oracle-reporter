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

import {IPowerOracleApp} from "./app/interface";
import {IPowerOracleWeb3} from "./web3/interface";
import {IPowerOracleTgBot} from "./tgBot/interface";
import {IPowerOracleStorage} from "./storage/interface";

(async() => {
    const powerOracleStorage: IPowerOracleStorage = await require('./storage')();
    const powerOracleWeb3: IPowerOracleWeb3 = await require('./web3')();
    const tgBot: IPowerOracleTgBot = await require('./tgBot')();
    const app: IPowerOracleApp = await require('./app')(powerOracleWeb3, powerOracleStorage, tgBot);
})().catch((e) => {
    console.error('app error', new Date(), e);
});


process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});
