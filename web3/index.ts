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

import {IPowerOracleWeb3} from "./interface";
const _ = require('lodash');
const Web3 = require("web3");
const pIteration = require("p-iteration");
const axios = require('axios');
const utils = require('../utils');

let config = require(process.env.MAINNET ? './config/mainnet' : './config/testnet');

module.exports = async (extendConfig) => {
  config = _.merge({}, config, extendConfig || {});

  const web3 = new PowerOracleWeb3();
  await web3.init();
  return web3;
};

class PowerOracleWeb3 implements IPowerOracleWeb3 {
  httpWeb3: any;
  httpCvpContract: any;
  httpOracleContract: any;
  httpOracleStackingContract: any;

  errorCallback;
  transactionCallback;

  requiredConfirmations = 3;

  contractsConfig;

  currentUserId;
  networkId;

  symbolsCache = {};

  activeTxTimestamp;

  constructor() {}

  async init() {
    await this.initHttpWeb3();
  }

  async initHttpWeb3() {
    this.httpWeb3 = new Web3(new Web3.providers.HttpProvider(config.httpRpc));
    await this.createHttpContractInstances();
    [this.currentUserId, this.networkId] = await Promise.all([
      this.getUserIdByPokerAddress(this.getCurrentPokerAddress()),
      this.getNetworkId()
    ]);
  }

  async createHttpContractInstances() {
    const {data: contractsConfig} = await axios.get(`https://test-app.powerpool.finance/config/${config.network}.json`);
    this.contractsConfig = contractsConfig;
    this.httpCvpContract = new this.httpWeb3.eth.Contract(contractsConfig.CvpAbi, contractsConfig.CvpAddress);
    this.httpOracleContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerOracleAbi, contractsConfig.PowerOracleAddress);
    this.httpOracleStackingContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerOracleStackingAbi, contractsConfig.PowerOracleStackingAddress);
  }

  async getTokenSymbol(tokenAddress) {
    tokenAddress = tokenAddress.toLowerCase();
    if(tokenAddress === '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2') {
      return 'MKR';
    }
    if(tokenAddress === '0x0000000000000000000000000000000000000000') {
      return 'ETH';
    }
    if(!_.isUndefined(this.symbolsCache[tokenAddress])) {
      return this.symbolsCache[tokenAddress];
    }
    const tokenContract = new this.httpWeb3.eth.Contract(this.contractsConfig.CvpAbi, tokenAddress);
    let symbol;
    try {
      symbol = await tokenContract.methods.symbol().call();
    } catch (e) {
      symbol = await tokenContract.methods._symbol().call().catch(() => null);
    }
    this.symbolsCache[tokenAddress] = symbol;
    return symbol;
  }

  async isCurrentAccountReporter() {
    return this.currentUserId === await this.getActualReporterUserId();
  }

  async getActualReporterUserId() {
    return utils.normalizeNumber(await this.httpOracleStackingContract.methods.getReporterId().call());
  }

  async getUserIdByPokerAddress(pokerKey) {
    pokerKey = pokerKey.toLowerCase();
    const userCreated = await this.httpOracleStackingContract.getPastEvents('CreateUser', { fromBlock: 0, filter: { pokerKey } }).then(events => events[0]);
    if (!userCreated) {
      return null;
    }
    return utils.normalizeNumber(userCreated.returnValues.userId);
  }

  async getTokensCount() {
    return utils.normalizeNumber(await this.httpOracleContract.methods.numTokens().call());
  }

  async getTokenByIndex(index) {
    return this.httpOracleContract.methods.getTokenConfig(index).call().then(async t => ({
      baseUnit: t.baseUnit,
      fixedPrice: t.fixedPrice,
      isUniswapReversed: t.isUniswapReversed,
      priceSource: utils.normalizeNumber(t.priceSource),
      symbolHash: t.symbolHash,
      symbol: await this.getTokenSymbol(t.underlying),
      underlying: t.underlying.toLowerCase(),
      uniswapMarket: t.uniswapMarket,
    }));
  }

  async getUserById(userId) {
    return this.httpOracleStackingContract.methods.users(userId).call().then(async t => ({
      deposit: utils.weiToEther(t.deposit),
      adminKey: t.adminKey,
      pokerKey: t.pokerKey,
      financierKey: t.financierKey
    }));
  }

  async getTokens() {
    const arr = Array.from(Array(await this.getTokensCount()).keys());
    return pIteration
        .map(arr, (i) => this.getTokenByIndex(i))
        .then(tokens => tokens.filter(t => t.priceSource === 2));
  }

  async getTokensSymbols() {
    return this.getTokens().then(tokens => tokens.map(t => t.symbol));
  }

  async getTokenPriceBySymbolHash(symbolHash) {
    return this.httpOracleContract.methods.prices(symbolHash).call().then(async p => ({
      timestamp: utils.normalizeNumber(p.timestamp),
      value: utils.normalizeNumber(p.value),
    }));
  }

  async getTokenPrices() {
    const tokens = await this.getTokens();
    return pIteration.map(tokens, async (t) => ({
      ... await this.getTokenPriceBySymbolHash(t.symbolHash),
      token: t
    }));
  }

  async getDeltaUntilReportByTokenIndex(index) {
    const token = await this.getTokenByIndex(index);
    const tokenPrice = await this.getTokenPriceBySymbolHash(token.symbolHash);
    return this.getTimestamp() - tokenPrice.timestamp;
  }

  async getReportIntervals() {
    const [minReportInterval, maxReportInterval] = await Promise.all([
      this.httpOracleContract.methods.minReportInterval().call(),
      this.httpOracleContract.methods.maxReportInterval().call(),
    ])
    return {minReportInterval, maxReportInterval};
  }

  async getSymbolForReport() {
    const [{minReportInterval}, prices] = await Promise.all([
      this.getReportIntervals(),
      this.getTokenPrices(),
    ]);
    return prices.filter(p => {
      const delta = this.getTimestamp() - p.timestamp;
      return delta > minReportInterval;
    }).map(p => p.token.symbol);//.filter(s => s !== 'ETH' && s !== 'USDC' && s !== 'USDT');
  }

  async getSymbolsForSlash() {
    const [{maxReportInterval}, prices] = await Promise.all([
      this.getReportIntervals(),
      this.getTokenPrices(),
    ]);
    return prices.filter(p => {
      const delta = this.getTimestamp() - p.timestamp;
      return delta > maxReportInterval;
    }).map(p => p.token.symbol);//.filter(s => s !== 'ETH' && s !== 'USDC' && s !== 'USDT');
  }

  async getNetworkId() {
    return utils.normalizeNumber(await this.httpWeb3.eth.net.getId());
  }

  async getEthBalance(userAddress) {
    return utils.weiToEther(await this.httpWeb3.eth.getBalance(userAddress));
  }

  getTimestamp() {
    return Math.floor(new Date().getTime() / 1000);
  }

  async getGasPrice() {
    if (this.networkId === 1) {
      try {
        const { data: gasData } = await axios.get('https://etherchain.org/api/gasPriceOracle');
        return utils.gweiToWei(parseFloat(gasData.fast) + 3);
      } catch (e) {
        return parseInt((await this.httpWeb3.eth.getGasPrice()).toString(10)) * 1.5;
      }
    } else {
      return 1000000000;
    }
  }

  getCurrentPokerAddress() {
    return config.poker.address;
  }

  getDelayUntilNewTransaction() {
    return config.delayUntilNewTransaction;
  }

  async checkAndActionAsSlasher() {
    console.log('checkAndActionAsSlasher', this.currentUserId, await this.getActualReporterUserId());
    const [curUser, reporterUser] = await Promise.all([
        this.getUserById(this.currentUserId),
        this.getUserById(await this.getActualReporterUserId())
    ]);
    console.log('curUser.deposit', curUser.deposit, 'reporterUser.deposit', reporterUser.deposit);
    if(curUser.deposit > reporterUser.deposit) {
      return this.setReporter();
    }
    const symbolToSlash = await this.getSymbolsForSlash();
    if(!symbolToSlash.length) {
      return;
    }
    return this.pokeFromSlasher(symbolToSlash);
  }

  async checkAndActionAsReporter() {
    console.log('checkAndActionAsReporter');
    const symbolsToReport = await this.getSymbolForReport();
    if(!symbolsToReport.length) {
      return;
    }
    return this.pokeFromReporter(symbolsToReport);
  }

  async pokeFromSlasher(symbols) {
    console.log('pokeFromSlasher', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'pokeFromSlasher',
        [this.currentUserId, symbols],
        config.poker.privateKey
    );
  }

  async pokeFromReporter(symbols) {
    console.log('pokeFromReporter', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'pokeFromReporter',
        [this.currentUserId, symbols],
        config.poker.privateKey
    );
  }

  async setReporter() {
    console.log('setReporter');
    return this.sendMethod(
        this.httpOracleStackingContract,
        'setReporter',
        [this.currentUserId],
        config.poker.privateKey
    );
  }

  async sendMethod(contract, methodName, args, fromPrivateKey, nonce = null, gasPriceMul = 1) {
    const contractAddress = contract._address;
    const method = contract.methods[methodName].apply(this, args);
    const from = utils.getAddressByPrivateKey(fromPrivateKey);
    const signedTx = await this.getTransaction(method, contractAddress, from, fromPrivateKey, nonce, gasPriceMul);

    return new Promise((resolve, reject) => {
      this.activeTxTimestamp = this.getTimestamp();

      const response = this.httpWeb3.eth.sendSignedTransaction(signedTx.rawTransaction, (err, hash) => {
        if(err && _.includes(err.message, "Transaction gas price")) {
          return resolve(this.sendMethod(contract, methodName, args, fromPrivateKey, nonce, gasPriceMul * 1.3));
        } else if(err) {
          // if(_.includes(err.message, "Insufficient funds"))
          this.activeTxTimestamp = null;
          console.log('❌ Error', err.message);
          return reject(err);
        }
        this.activeTxTimestamp = null;
        console.log('✅ Sent', hash);

        if(this.transactionCallback) {
          this.transactionCallback(hash);
        }

        resolve({
          hash: hash,
          promise: response,
          // nonce: options.nonce,
          // gasPrice: gasPrice
        });
      })
    })
  }

  async getTransaction(method, contractAddress, from, privateKey, nonce = null, gasPriceMul = 1) {
    const gasPrice = (await this.getGasPrice()) * gasPriceMul;
    let options: any = { from, gasPrice, nonce };

    const encodedABI = method.encodeABI();
    if (!options.nonce) {
      options.nonce = await this.httpWeb3.eth.getTransactionCount(from);
    }

    if (typeof options.nonce === "string") {
      options.nonce = this.httpWeb3.utils.hexToNumber(options.nonce);
    }

    options.gas = Math.round((await method.estimateGas(options)) * 1.1);

    options = {
      ...options,
      data: encodedABI,
      to: contractAddress
    };
    return this.httpWeb3.eth.accounts.signTransaction(options, privateKey, false);
  }

  async getTransactionStatus(txHash) {
    const response = await this.httpWeb3.eth.getTransactionReceipt(txHash);
    if (!response) {
      return 'not_found';
    }

    const txBlockNumber = response.blockNumber;
    if(!response.status) {
      return 'reverted';
    }

    const currentBlock = utils.normalizeNumber(await this.httpWeb3.eth.getBlockNumber());
    const confirmations = currentBlock - txBlockNumber;
    if (confirmations >= this.requiredConfirmations) {
      return 'confirmed';
    }
    return 'pending';
  }

  async waitForTransactionConfirmed(txHash) {
    return new Promise((resolve, reject) => {
      let iterations = 0;
      const interval = setInterval(async () => {
        iterations++;
        if(iterations >= 1000) {
          return reject();
        }
        const status = await this.getTransactionStatus(txHash);
        if(_.includes(['confirmed', 'reverted'])) {
          clearInterval(interval);
          resolve(status);
        }
      }, 5 * 1000);
    });
  }

  onError(callback) {
    this.errorCallback = callback;
  }

  onTransaction(callback) {
    this.transactionCallback = callback;
  }
}
