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
const _ = require('lodash');
const web3Utils = require('web3-utils');
const {toBN} = web3Utils;

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

    roundNumber(value, roundTo = 1) {
        return Math.round(value * 10 ** roundTo) / 10 ** roundTo;
    },

    weiToEther(wei, roundTo = null) {
        const result = parseFloat(web3Utils.fromWei(wei, 'ether'));
        return roundTo ? utils.roundNumber(result, roundTo) : result;
    },

    gweiToWei(gwei) {
        return web3Utils.toWei(utils.normalizeNumber(gwei).toFixed(9), 'gwei');
    },

    weiToGwei(wei) {
        return parseFloat(web3Utils.fromWei(wei, 'gwei'));
    },

    getTimestamp() {
        return Math.floor(new Date().getTime() / 1000);
    },

    mul(a, b) {
        return toBN(a.toString(10), 10).mul(toBN(b.toString(10), 10)).toString(10);
    },
    add(a, b) {
        return toBN(a.toString(10), 10).add(toBN(b.toString(10), 10)).toString(10);
    },
    sub(a, b) {
        return toBN(a.toString(10), 10).sub(toBN(b.toString(10), 10)).toString(10);
    },

    gte(a, b) {
        return toBN(a.toString(10), 10).gte(toBN(b.toString(10), 10));
    },

    greaterThenDecimals(n, d) {
        return toBN(n.toString(10), 10).gt(toBN((10 ** d).toString(10), 10));
    },

    weiToNumber(wei, d) {
        const zero = toBN(0);
        const negative1 = toBN(-1);

        const negative = toBN(wei.toString(10), 10).lt(zero);
        const bLength = (10 ** d).toString().length - 1 || 1;
        const dBN = toBN((10 ** d).toString(10), 10);

        if (negative) {
            wei = toBN(wei.toString(10), 10).mul(negative1);
        }

        let f = toBN(wei.toString(10), 10).mod(dBN).toString(10);
        while (f.length < bLength) {
            f = '0' + f;
        }

        f = f.match(/^([0-9]*[1-9]|0)(0*)/)[1];
        const whole = toBN(wei.toString(10), 10).div(dBN).toString(10);

        let v = '' + whole + (f == '0' ? '' : '.' + f);
        if (negative) {
            v = '-' + v;
        }
        return parseFloat(_.trim(v, '.'));
    },

    tgClear(text) {
        return utils.clearHome(utils.clearTags(text));
    },

    clearTags(text) {
        return text.replace(/<|>/g, '');
    },

    clearHome(text) {
        return text.replace(/\/home\/[^\/]+\//g, '');
    },

    txLink(explorerTxUrl, txHash) {
        return `<a href="${explorerTxUrl}${txHash}">${txHash.slice(0, 7) + "..." + txHash.slice(-4)}</a>`;
    },
    addressLink(explorerTxUrl, addressHash) {
        return `<a href="${explorerTxUrl}${addressHash}">${addressHash.slice(0, 7) + "..." + addressHash.slice(-4)}</a>`;
    },
    extractJSON(str) {
        var firstOpen, firstClose, candidate;
        firstOpen = str.indexOf('{', firstOpen + 1);
        do {
            firstClose = str.lastIndexOf('}');
            console.log('firstOpen: ' + firstOpen, 'firstClose: ' + firstClose);
            if(firstClose <= firstOpen) {
                return null;
            }
            do {
                candidate = str.substring(firstOpen, firstClose + 1);
                console.log('candidate: ' + candidate);
                try {
                    var res = JSON.parse(candidate);
                    console.log('...found');
                    return [res, firstOpen, firstClose + 1];
                }
                catch(e) {
                    console.log('...failed');
                }
                firstClose = str.substr(0, firstClose).lastIndexOf('}');
            } while(firstClose > firstOpen);
            firstOpen = str.indexOf('{', firstOpen + 1);
        } while(firstOpen != -1);
    }
};

module.exports = utils;
