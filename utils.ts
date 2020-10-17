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

const ethers = require('ethers');
const web3Utils = require('web3-utils');

const utils = {
    getAddressByPrivateKey(privateKey) {
        return new ethers.Wallet(privateKey).address;
    },

    normalizeNumber(number) {
        return parseFloat(number.toString(10));
    },

    isAddress(str) {
        return web3Utils.isAddress(str);
    },

    toHex(str) {
        return web3Utils.toHex(str);
    },

    keccak256(str) {
        return web3Utils.keccak256(str);
    },

    weiToEther(wei) {
        return parseFloat(web3Utils.fromWei(wei, 'ether'));
    },

    gweiToWei(gwei) {
        return web3Utils.toWei(utils.normalizeNumber(gwei).toFixed(9), 'gwei');
    }
};

module.exports = utils;