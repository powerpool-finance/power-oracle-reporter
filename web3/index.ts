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
  httpPokerContract: any;
  httpWeightsStrategyContract: any;

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
    console.log('initHttpWeb3', config.httpRpc);
    this.httpWeb3 = new Web3(new Web3.providers.HttpProvider(config.httpRpc));
    await this.createHttpContractInstances();
    [this.currentUserId, this.networkId] = await Promise.all([
      this.getUserIdByPokerAddress(this.getCurrentPokerAddress()),
      this.getNetworkId()
    ]);
  }

  async createHttpContractInstances() {
    const {data: contractsConfig} = await axios.get(`https://${process.env.MAINNET ? '' : 'test-'}app.powerpool.finance/config/${config.network}.json`);
    this.contractsConfig = contractsConfig;
    this.httpCvpContract = new this.httpWeb3.eth.Contract(contractsConfig.CvpAbi, contractsConfig.CvpAddress);
    this.httpOracleContract = new this.httpWeb3.eth.Contract(contractsConfig.PokeOracleAbi, contractsConfig.PokeOracleAddress);
    this.httpOracleStackingContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerPokeStackingAbi, contractsConfig.PowerPokeStackingAddress);
    this.httpPokerContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerPokeAbi, contractsConfig.PowerPokeAddress);
    if (contractsConfig.WeightsStrategyAddress) {
      this.httpWeightsStrategyContract = new this.httpWeb3.eth.Contract(contractsConfig.WeightsStrategyAbi, contractsConfig.WeightsStrategyAddress);
    }
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
    const tokenContract = new this.httpWeb3.eth.Contract([{
      constant: true,
      inputs: [],
      name: "_symbol",
      outputs: [{ name: "", type: "string" }],
      payable: false,
      stateMutability: "view",
      type: "function",
      signature: "0xb09f1266",
    }, {
      constant: true,
      inputs: [],
      name: "symbol",
      outputs: [{ name: "", type: "string" }],
      payable: false,
      stateMutability: "view",
      type: "function",
    }], tokenAddress);
    let symbol;
    try {
      symbol = await tokenContract.methods.symbol().call();
    } catch (e) {
      symbol = await tokenContract.methods._symbol().call().catch(() => null);
    }
    this.symbolsCache[tokenAddress] = symbol;
    return symbol;
  }

  async getPoolsToRebalance() {
    const [{minReportInterval}, pools] = await Promise.all([
      this.getWeightsStrategyReportIntervals(),
      this.getActivePools(),
    ]);
    const timestamp = await this.getTimestamp();
    console.log('getSymbolForReport timestamp', timestamp);
    return pools.filter(p => {
      const delta = timestamp - p.lastWeightsUpdate;
      console.log('p.lastWeightsUpdate', p.lastWeightsUpdate, 'delta', delta);
      return delta > minReportInterval;
    }).map(p => p.address);
  }

  async getActivePools() {
    return this.getActivePoolsAddresses().then(addresses => pIteration.map(addresses, (a) => this.getWeightsStrategyPool(a)));
  }

  async getWeightsStrategyPool(poolAddress) {
    return this.httpWeightsStrategyContract.methods.poolsData(poolAddress).call().then(p => ({
      ...p,
      lastWeightsUpdate: utils.normalizeNumber(p.lastWeightsUpdate),
      address: poolAddress
    }));
  }

  async getActivePoolsAddresses() {
    return this.httpWeightsStrategyContract.methods.getActivePoolsList().call();
  }

  async getWeightsStrategyReportIntervals() {
    const {min: minReportInterval, max: maxReportInterval} = await this.httpPokerContract.methods.getMinMaxReportIntervals(this.httpWeightsStrategyContract._address).call();
    return {
      minReportInterval: utils.normalizeNumber(minReportInterval),
      maxReportInterval: utils.normalizeNumber(maxReportInterval)
    };
  }

  async isCurrentAccountReporter() {
    return this.currentUserId === await this.getActualReporterUserId();
  }

  async getActualReporterUserId() {
    return utils.normalizeNumber(await this.httpOracleStackingContract.methods.getHDHID().call());
  }

  async getPendingReward() {
    return utils.weiToEther(await this.httpPokerContract.methods.rewards(this.currentUserId).call());
  }

  async getUserIdByPokerAddress(pokerKey) {
    pokerKey = pokerKey.toLowerCase();
    const userCreated = await this.httpOracleStackingContract.getPastEvents('CreateUser', { fromBlock: 0, filter: { pokerKey } }).then(events => events[0]);

    const userUpdated = _.last(await this.httpOracleStackingContract.getPastEvents('UpdateUser', { fromBlock: 0, filter: { pokerKey } }));

    let userId;
    if(userUpdated && (!userCreated || userUpdated.blockNumber > userCreated.blockNumber)) {
      userId = utils.normalizeNumber(userUpdated.returnValues.userId);
    } else if(userCreated) {
      userId = utils.normalizeNumber(userCreated.returnValues.userId);
    } else {
      return null;
    }
    const user = await this.getUserById(userId);
    return user && user.pokerKey.toLowerCase() === pokerKey ? userId : null;
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
    return (await this.getTimestamp()) - tokenPrice.timestamp;
  }

  async getLastSlasherUpdate(userId) {
    return this.httpOracleContract.methods.lastSlasherUpdates(userId).call()
        .then(slasherUpdate => utils.normalizeNumber(slasherUpdate));
  }

  async getOracleReportIntervals() {
    const {min: minReportInterval, max: maxReportInterval} = await this.httpPokerContract.methods.getMinMaxReportIntervals(this.httpOracleContract._address).call();
    return {
      minReportInterval: utils.normalizeNumber(minReportInterval),
      maxReportInterval: utils.normalizeNumber(maxReportInterval)
    };
  }

  processSymbols(symbols, filterSymbols = ['CVP', 'WETH', 'ETH']) {
    return symbols.map(s => s.replace('WETH', 'ETH')).filter(s => !_.includes(filterSymbols, s));
  }

  async getSymbolForReport() {
    const [{minReportInterval}, prices] = await Promise.all([
      this.getOracleReportIntervals(),
      this.getTokenPrices(),
    ]);
    const timestamp = await this.getTimestamp();
    console.log('getSymbolForReport timestamp', timestamp);
    return this.processSymbols(prices.filter(p => {
      const delta = timestamp - p.timestamp;
      console.log('p.timestamp', p.timestamp, 'delta', delta);
      return delta > minReportInterval;
    }).map(p => p.token.symbol));
  }

  async getSymbolsForSlash() {
    const [{maxReportInterval}, prices] = await Promise.all([
      this.getOracleReportIntervals(),
      this.getTokenPrices(),
    ]);
    const timestamp = await this.getTimestamp();
    return this.processSymbols(prices.filter(p => {
      const delta = timestamp - p.timestamp;
      return delta > maxReportInterval;
    }).map(p => p.token.symbol));
  }

  async getNetworkId() {
    return utils.normalizeNumber(await this.httpWeb3.eth.net.getId());
  }

  async getEthBalance(userAddress) {
    return utils.weiToEther(await this.httpWeb3.eth.getBalance(userAddress));
  }

  async getTimestamp() {
    const lastBlockNumber = (await this.getCurrentBlock()) - 1;
    console.log('getTimestamp lastBlockNumber', lastBlockNumber);
    return this.getBlockTimestamp(lastBlockNumber).catch((e) => {
      console.error('getBlockTimestamp', e);
      return new Promise((resolve) => {
        setTimeout(() => resolve(this.getBlockTimestamp(lastBlockNumber)), 5000);
      });
    })
  }

  async getBlockTimestamp(blockNumber) {
    return utils.normalizeNumber((await this.httpWeb3.eth.getBlock(blockNumber)).timestamp);
  }

  async getCurrentBlock() {
    return utils.normalizeNumber(await this.httpWeb3.eth.getBlockNumber());
  }

  async getGasPrice() {
    if (this.networkId === 1) {
      try {
        const { data: gasData } = await axios.get('https://etherchain.org/api/gasPriceOracle');
        return utils.gweiToWei(parseFloat(gasData.standard) + 5);
      } catch (e) {
        return Math.round(parseInt((await this.httpWeb3.eth.getGasPrice()).toString(10)) * 1.5);
      }
    } else {
      return utils.gweiToWei(_.random(10, 17));
    }
  }

  getCurrentPokerAddress() {
    return config.poker.address;
  }

  getDelayUntilNewTransaction() {
    return config.delayUntilNewTransaction;
  }

  async checkAndActionAsSlasher() {
    const timestamp = await this.getTimestamp();
    console.log('checkAndActionAsSlasher', this.currentUserId, await this.getActualReporterUserId());
    const [curUser, reporterUser, lastSlasherUpdate, {minReportInterval, maxReportInterval}] = await Promise.all([
        this.getUserById(this.currentUserId),
        this.getUserById(await this.getActualReporterUserId()),
        this.getLastSlasherUpdate(this.currentUserId),
        this.getOracleReportIntervals()
    ]);
    const intervalsDiff = maxReportInterval - minReportInterval;
    console.log('curUser.deposit', curUser.deposit, 'reporterUser.deposit', reporterUser.deposit);
    if(curUser.deposit > reporterUser.deposit) {
      return this.setReporter();
    }
    const symbolToSlash = await this.getSymbolsForSlash();
    if(symbolToSlash.length) {
      if(timestamp > intervalsDiff + lastSlasherUpdate) {
        return this.pokeFromSlasher(symbolToSlash);
      }
    } else if(timestamp > maxReportInterval + lastSlasherUpdate) {
      return this.slasherUpdate();
    }
  }

  async checkAndActionAsReporter() {
    console.log('checkAndActionAsReporter');

    const symbolsToReport = await this.getSymbolForReport();
    if(symbolsToReport.length) {
      await this.oraclePokeFromReporter(symbolsToReport);
    }
    if (this.httpWeightsStrategyContract) {
      const poolsToRebalance = await this.getPoolsToRebalance();
      if(poolsToRebalance.length) {
        await this.weightsStrategyPokeFromReporter(poolsToRebalance);
      }
    }
  }

  getPokeOpts() {
    return this.httpWeb3.eth.abi.encodeParameter(
        {
          PowerPokeRewardOpts: {
            to: 'address',
            compensateInETH: 'bool'
          },
        },
        config.poker.opts
    );
  }

  async pokeFromSlasher(symbols) {
    console.log('pokeFromSlasher', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'pokeFromSlasher',
        [this.currentUserId, symbols, this.getPokeOpts()],
        config.poker.privateKey
    );
  }

  async weightsStrategyPokeFromReporter(pools) {
    console.log('weightsStrategyPokeFromReporter', pools);
    return this.sendMethod(
      this.httpWeightsStrategyContract,
      'pokeFromReporter',
      [this.currentUserId, pools, this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  async oraclePokeFromReporter(symbols) {
    console.log('oraclePokeFromReporter', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'pokeFromReporter',
        [this.currentUserId, symbols, this.getPokeOpts()],
        config.poker.privateKey
    );
  }

  async poke(symbols) {
    console.log('poke', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'poke',
        [symbols],
        config.poker.privateKey
    );
  }

  async slasherUpdate() {
    console.log('slasherUpdate');
    return this.sendMethod(
        this.httpOracleContract,
        'slasherUpdate',
        [this.currentUserId],
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

    return new Promise(async (resolve, reject) => {
      this.activeTxTimestamp = await this.getTimestamp();

      const response = this.httpWeb3.eth.sendSignedTransaction(signedTx.rawTransaction, async (err, hash) => {
        if(err && (_.includes(err.message, "Transaction gas price") || _.includes(err.message, "replacement transaction underpriced"))) {
          return resolve(this.sendMethod(contract, methodName, args, fromPrivateKey, nonce, gasPriceMul * 1.3));
        } else if(err && _.includes(err.message, "Insufficient funds")) {
          this.activeTxTimestamp = null;
          console.log('❌ Error', err.message);
          return reject(new Error('Insufficient ETH funds. Current balance: ' + (await this.getEthBalance(from)) + ' ETH'));
        } else if(err) {
          this.activeTxTimestamp = null;
          console.log('❌ Error', err.message);
          return reject(err);
        }
        console.log('✅ Sent', hash);

        try {
          await this.waitForTransactionConfirmed(hash);
        } catch (e) {
          this.activeTxTimestamp = null;
          console.log('waitForTransactionConfirmed Error', e);
          return reject(new Error('Sent transaction not found: ' + hash));
        }

        this.activeTxTimestamp = null;

        if(this.transactionCallback) {
          setTimeout(() => {
            this.transactionCallback(hash);
          }, 10 * 1000);
        }

        resolve({
          hash: hash,
          promise: response,
        });
      })
    })
  }

  async getTransaction(method, contractAddress, from, privateKey, nonce = null, gasPriceMul = 1) {
    const gasPrice = Math.round((await this.getGasPrice()) * gasPriceMul);
    const encodedABI = method.encodeABI();

    const gweiGasPrice = parseFloat(utils.weiToGwei(gasPrice));
    if(gweiGasPrice > parseFloat(config.maxGasPrice)) {
      throw new Error('Max Gas Price: ' + Math.round(gweiGasPrice));
    }

    let options: any = { from, gasPrice, nonce, data: encodedABI, to: contractAddress };

    if (!options.nonce) {
      options.nonce = await this.httpWeb3.eth.getTransactionCount(from);
    }

    if (typeof options.nonce === "string") {
      options.nonce = this.httpWeb3.utils.hexToNumber(options.nonce);
    }

    try {
      options.gas = Math.round((await method.estimateGas(options)) * 1.1);
    } catch (e) {
      throw new Error('Revert: ' + JSON.stringify(options))
    }

    return this.httpWeb3.eth.accounts.signTransaction(options, privateKey, false);
  }

  async getTransactionStatus(txHash) {
    return this.getTransactionStatusByReceipt(await this.httpWeb3.eth.getTransactionReceipt(txHash));
  }


  async getTransactionStatusByReceipt(receipt) {
    if (!receipt) {
      return 'not_found';
    }

    const txBlockNumber = receipt.blockNumber;
    if(!receipt.status) {
      return 'reverted';
    }

    const currentBlock = await this.getCurrentBlock();
    const confirmations = currentBlock - txBlockNumber;
    if (confirmations >= this.requiredConfirmations) {
      return 'confirmed';
    }
    return 'pending';
  }

  waitForTransactionConfirmed(txHash) {
    return new Promise((resolve, reject) => {
      let iterations = 0;
      const interval = setInterval(async () => {
        iterations++;
        if(iterations >= 1000) {
          return reject();
        }
        const status = await this.getTransactionStatus(txHash);
        if(_.includes(['confirmed', 'reverted'], status)) {
          clearInterval(interval);
          resolve(status);
        }
      }, 5 * 1000);
    });
  }

  findAbiItemBySignature(signature) {
    let abiMethod;
    _.some(this.contractsConfig, (value, name) => {
      if(!_.includes(name, 'Abi')) {
        return false;
      }
      abiMethod = _.find(value, (abiMethod) => {
        let abiSignature = abiMethod.signature;
        if (abiMethod.type === 'fallback') {
          return false;
        }
        if (!abiSignature) {
          try {
            abiSignature = this.httpWeb3.eth.abi.encodeFunctionSignature(abiMethod);
          } catch (e) {}
        }
        return abiSignature && abiSignature === signature;
      });
      return !!abiMethod;
    });
    return abiMethod;
  }

  convertValuesByInputs(inputs, decoded) {
    const values = {};

    inputs.forEach((inputAbi) => {
      let {name} = inputAbi;
      let value = decoded[name];
      name = _.trim(name, '-_');

      let decimals = 0;
      let number;
      if(_.includes(inputAbi.type, 'int256[')) {
        number = value[0];
      } else if(_.includes(inputAbi.type, 'int256')) {
        number = value;
      }

      if(number && utils.greaterThenDecimals(number, 14)) {
        decimals = 18;
      } else if(number && utils.greaterThenDecimals(number, 3)) {
        decimals = 6;
      }

      if(number && decimals) {
        values[name] = utils.weiToNumber(number, decimals);
      } else {
        values[name] = value;
      }
    });
    return values;
  }

  parseData(data) {
    const methodSignature = data.slice(0, 10);
    if (methodSignature === '0x00000000') {
      return null;
    }

    let abiMethod = this.findAbiItemBySignature(methodSignature);

    if(!abiMethod) {
      return null;
    }

    const methodName = abiMethod.name;

    let decoded = {};
    if (data.slice(10)) {
      decoded = this.httpWeb3.eth.abi.decodeParameters(abiMethod.inputs, '0x' + data.slice(10));
    }

    const values = this.convertValuesByInputs(abiMethod.inputs, decoded);

    return {
      methodName,
      values,
    };
  }

  async parseTxData(txHash) {
    try {
      const [tx, receipt] = await Promise.all([
          this.httpWeb3.eth.getTransaction(txHash),
          this.httpWeb3.eth.getTransactionReceipt(txHash),
      ]);
      const status = await this.getTransactionStatusByReceipt(receipt);

      const {input: data, gas, gasPrice} = tx;
      const weiSpent = utils.mul(gas, gasPrice);
      return {
        ethSpent: utils.weiToEther(weiSpent),
        weiSpent,
        status,
        events: this.parseLogs(receipt.logs),
        ...this.parseData(data)
      };
    } catch (e) {
      console.error('parseTxData', txHash, e);
      return null;
    }
  }

  parseLogs(logs) {
    return logs.map((log) => {
      let abiEvent = this.findAbiItemBySignature(log.topics[0]);
      if (!abiEvent) {
        return null;
      }
      const {inputs} = abiEvent;
      const decoded = this.httpWeb3.eth.abi.decodeLog(inputs, log.data === '0x' ? null : log.data, log.topics.slice(1));
      const values = this.convertValuesByInputs(inputs, decoded);
      let name = abiEvent.name;
      return {
        name,
        txHash: log.transactionHash,
        signature: log.topics[0],
        values,
        inputs
      }
    })
  }

  getTxLink(txHash) {
    return utils.txLink(this.contractsConfig.explorerTxUrl, txHash);
  }

  getAddressLink(addressHash) {
    return utils.txLink(this.contractsConfig.explorerAddressUrl, addressHash);
  }

  onError(callback) {
    this.errorCallback = callback;
  }

  onTransaction(callback) {
    this.transactionCallback = callback;
  }
}
