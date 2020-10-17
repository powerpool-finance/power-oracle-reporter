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

export {};

const utils = require('../../utils');

module.exports = {
    'httpRpc': process.env.RPC_SERVER || 'https://mainnet-eth.compound.finance',
    'delayUntilNewTransaction': process.env.NEW_TX_DELAY || 10 * 60,
    'poker': {
        'privateKey': process.env.POKER_PRIVATE_KEY,
        'address': utils.getAddressByPrivateKey(process.env.POKER_PRIVATE_KEY)
    },
    'network': process.env.NETWORK || 'mainnet'
};
