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
const fs = require('fs');

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
  httpStackingContract: any;
  httpPokerContract: any;
  httpUniswapRouterContract: any;
  httpWeightsStrategyContract: any;
  httpIndicesZapContract: any;
  httpCvpMakerContract: any;
  httpRouterContracts: any[];
  httpRebindStrategyContracts: any[];

  errorCallback;
  transactionCallback;

  requiredConfirmations = 3;

  contractsConfig;
  wethAddress;
  cvpAddress;

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
    console.log('blockNumber', await this.getCurrentBlock());
    await this.createHttpContractInstances();
    [this.currentUserId, this.networkId] = await Promise.all([
      this.getUserIdByPokerAddress(this.getCurrentPokerAddress()),
      this.getNetworkId()
    ]);
  }

  async createHttpContractInstances() {
    const contractsConfig = JSON.parse(fs.readFileSync('./config/' + config.network + '.json', {encoding: 'utf8'}));
    this.contractsConfig = contractsConfig;

    this.httpCvpContract = new this.httpWeb3.eth.Contract(contractsConfig.CvpAbi, contractsConfig.CvpAddress);
    this.httpOracleContract = new this.httpWeb3.eth.Contract(contractsConfig.PokeOracleAbi, contractsConfig.PokeOracleAddress);
    this.httpStackingContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerPokeStackingAbi, contractsConfig.PowerPokeStackingAddress);
    this.httpPokerContract = new this.httpWeb3.eth.Contract(contractsConfig.PowerPokeAbi, contractsConfig.PowerPokeAddress);
    this.httpUniswapRouterContract = new this.httpWeb3.eth.Contract(contractsConfig.UniswapRouterAbi, contractsConfig.UniswapRouterAddress);

    this.wethAddress = _.find(this.contractsConfig.Tokens, t => t.symbol === 'WETH').address;
    this.cvpAddress = this.httpCvpContract._address.toLowerCase();

    if (contractsConfig.WeightsStrategyAddress) {
      this.httpWeightsStrategyContract = new this.httpWeb3.eth.Contract(contractsConfig.WeightsStrategyAbi, contractsConfig.WeightsStrategyAddress);
    }
    if (contractsConfig.IndicesZapAddress) {
      this.httpIndicesZapContract = new this.httpWeb3.eth.Contract(contractsConfig.IndicesZapAbi, contractsConfig.IndicesZapAddress);
    }
    if (contractsConfig.piTokenRouters) {
      this.httpRouterContracts = contractsConfig.piTokenRouters.map(address => {
        if (address === '0x5f85c951bdf84ee5c1a304d07fd8a7cd612fd4ae') {
          return new this.httpWeb3.eth.Contract(contractsConfig.PiTokenSushiRouterAbi, address);
        } else {
          return new this.httpWeb3.eth.Contract(contractsConfig.PiTokenTornRouterAbi, address);
        }
      })
    }
    if (contractsConfig.rebindStrategyAddresses) {
      this.httpRebindStrategyContracts = contractsConfig.rebindStrategyAddresses.map(address => {
        return new this.httpWeb3.eth.Contract(contractsConfig.RebindStrategyAbi, address);
      })
    }
    if (contractsConfig.CvpMakerAddress) {
      this.httpCvpMakerContract = new this.httpWeb3.eth.Contract(contractsConfig.CvpMakerAbi, contractsConfig.CvpMakerAddress);
    }
  }

  // ==============================================================
  // GENERAL ACTIONS
  // ==============================================================

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
      return this.oracleSetReporter();
    }
    const symbolToSlash = await this.getSymbolsForSlash();
    if(symbolToSlash.length) {
      if(timestamp > intervalsDiff + lastSlasherUpdate) {
        return this.oraclePokeFromSlasher(symbolToSlash);
      }
    } else if(timestamp > maxReportInterval + lastSlasherUpdate) {
      return this.oracleSlasherUpdate();
    }
  }

  async checkAndActionAsReporter() {
    console.log('checkAndActionAsReporter');

    const symbolsToReport = await this.getSymbolForReport();
    if (symbolsToReport.length) {
      await this.oraclePokeFromReporter(symbolsToReport);
    }
    if (this.httpWeightsStrategyContract) {
      const poolsToRebalance = await this.getWeightStrategyPoolsToRebalance();
      if (poolsToRebalance.length) {
        await this.weightsStrategyPokeFromReporter(poolsToRebalance);
      }
    }
    if (this.httpIndicesZapContract) {
      const rounds = await this.getReadyToExecuteRounds();
      const roundsToSupply = await this.filterRoundsToSupply(rounds);
      if (roundsToSupply.length) {
        await this.indicesZapSupplyRedeemPokeFromReporter(roundsToSupply.map(r => r.key));
      }
      const roundsToClaim = await this.filterRoundsToClaim(rounds);
      if (roundsToClaim.length) {
        await this.indicesZapClaimPokeFromReporter(roundsToClaim[0].key, roundsToClaim[0].users);
      }
    }
    if (this.httpRouterContracts) {
      const routersToPoke = await this.getRoutersToPoke();
      await pIteration.forEachSeries(routersToPoke, (routerToPoke) => {
        return this.routerPokeFromReporter(routerToPoke);
      }).catch(() => {});
    }
    if (this.httpRebindStrategyContracts) {
      const rebindersToPoke = await this.getRebindersToPoke();
      await pIteration.forEachSeries(rebindersToPoke, (rebinderToPoke) => {
        return this.rebinderPokeFromReporter(rebinderToPoke);
      });
    }
    if (this.httpCvpMakerContract) {
      const tokenToPoker = await this.getTokenToMakeCvp();
      if (tokenToPoker) {
        return this.cvpMakerPokeFromReporter(tokenToPoker);
      }
    }
  }

  // ==============================================================
  // STAKING
  // ==============================================================

  async isCurrentAccountReporter() {
    return this.currentUserId === await this.getActualReporterUserId();
  }

  async getActualReporterUserId() {
    return utils.normalizeNumber(await this.httpStackingContract.methods.getHDHID().call());
  }

  async getPendingReward() {
    return utils.weiToEther(await this.httpPokerContract.methods.rewards(this.currentUserId).call());
  }

  async getCreditOf(clientContract) {
    return utils.weiToEther(await this.httpPokerContract.methods.creditOf(clientContract).call().then(r => {
      console.log('getCreditOf', clientContract, r);
      return r;
    }));
  }

  async getUserById(userId) {
    return this.httpStackingContract.methods.users(userId).call().then(async t => ({
      deposit: utils.weiToEther(t.deposit),
      adminKey: t.adminKey,
      pokerKey: t.pokerKey,
      financierKey: t.financierKey
    }));
  }

  async getUserIdByPokerAddress(pokerKey) {
    pokerKey = pokerKey.toLowerCase();
    const fromBlock = this.getFromBlock(this.httpStackingContract);
    const userCreated = await this.httpStackingContract.getPastEvents('CreateUser', { fromBlock, filter: { pokerKey } }).then(events => events[0]);

    const userUpdated = _.last(await this.httpStackingContract.getPastEvents('UpdateUser', { fromBlock, filter: { pokerKey } }));

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

  // ==============================================================
  // ROUTERS
  // ==============================================================

  getPiTokenContract(address) {
    return new this.httpWeb3.eth.Contract(this.contractsConfig.PiTokenAbi, address);
  }
  async getPiTokenUnderlyingBalance(routerContract) {
    return this.getPiTokenContract(await routerContract.methods.piToken().call()).methods.getUnderlyingBalance().call();
  }
  async getRouterTokenUnderlyingStaked(routerContract) {
    return routerContract.methods.getUnderlyingStaked().call();
  }
  async getStakeAndClaimStatus(routerContract) {
    const c = await routerContract.methods.connectors('0').call().then(c => {
      c.stakeData = c.stakeData || '0x';
      c.pokeData = c.pokeData || '0x';
      c.stakeParams = c.stakeParams || '0x';
      c.claimParams = c.claimParams || '0x';
      return c;
    });

    const res = await routerContract.methods.getStakeAndClaimStatus(
      await this.getPiTokenUnderlyingBalance(routerContract),
      await this.getRouterTokenUnderlyingStaked(routerContract),
      await this.getRouterTokenUnderlyingStaked(routerContract),
      '0',
      true,
      c
    ).call({
      ...await this.getGasPriceOptions(5),
      from: utils.getAddressByPrivateKey(config.poker.privateKey),
      gas: 1e6
    });

    if (res.forceRebalance && res.status.toString() === '0') {
      // force claim rewards
      res.forceRebalance = await routerContract.methods.claimRewardsIntervalReached(c.lastClaimRewardsAt).call();
      console.log('claimRewardsIntervalReached', res.forceRebalance, 'c.lastClaimRewardsAt', c.lastClaimRewardsAt.toString());
    }
    return res;
  }
  async getRoutersToPoke() {
    const timestamp = await this.getTimestamp();
    return pIteration.filter(this.httpRouterContracts, async (routerContract) => {
      let [{min: minReportInterval, max: maxReportInterval}, lastRebalancedAt, reserveStatus] = await Promise.all([
        this.httpPokerContract.methods.getMinMaxReportIntervals(routerContract._address).call(),
        (routerContract.methods.lastRebalancedAt || routerContract.methods.lastRebalancedByPokerAt)().call().then(r => utils.normalizeNumber(r)),
        routerContract.methods.getReserveStatusForStakedBalance ? routerContract.methods.getReserveStatusForStakedBalance().call() : this.getStakeAndClaimStatus(routerContract)
      ]);
      minReportInterval = utils.normalizeNumber(minReportInterval);
      maxReportInterval = utils.normalizeNumber(maxReportInterval);
      const diff = timestamp - lastRebalancedAt;
      console.log('routerContract', routerContract._address);
      console.log('diff > minReportInterval', diff > minReportInterval, 'reserveStatus.status.toString()', reserveStatus.status.toString(), 'reserveStatus.forceRebalance', reserveStatus.forceRebalance);
      return (diff > minReportInterval && reserveStatus.status.toString() !== '0') || reserveStatus.forceRebalance;
    })
  }

  async routerPokeFromReporter(contract) {
    console.log('routerPokeFromReporter');
    return this.sendMethod(
      contract,
      'pokeFromReporter',
      [this.currentUserId, true, this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  // ==============================================================
  // REBIND STRATEGY
  // ==============================================================

  async getRebindersToPoke() {
    const timestamp = await this.getTimestamp();
    return pIteration.filter(this.httpRebindStrategyContracts, async (rebindContract) => {
      let [{min: minReportInterval, max: maxReportInterval}, lastRebalancedAt] = await Promise.all([
        this.httpPokerContract.methods.getMinMaxReportIntervals(rebindContract._address).call(),
        rebindContract.methods.lastUpdate().call().then(r => utils.normalizeNumber(r)),
      ]);
      minReportInterval = utils.normalizeNumber(minReportInterval);
      maxReportInterval = utils.normalizeNumber(maxReportInterval);
      const diff = timestamp - lastRebalancedAt;
      return diff > minReportInterval;
    })
  }

  async rebinderPokeFromReporter(contract) {
    console.log('rebinderPokeFromReporter');
    return this.sendMethod(
      contract,
      'pokeFromReporter',
      [this.currentUserId, this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  // ==============================================================
  // WEIGHT STRATEGY
  // ==============================================================

  async getWeightStrategyPoolsToRebalance() {
    const [{minReportInterval}, pools] = await Promise.all([
      this.getWeightsStrategyReportIntervals(),
      this.getWeightStrategyActivePools(),
    ]);
    const timestamp = await this.getTimestamp();
    return pools.filter(p => {
      const delta = timestamp - p.lastWeightsUpdate;
      return delta > minReportInterval;
    }).map(p => p.address);
  }

  async getWeightStrategyActivePools() {
    return this.getWeightStrategyActivePoolsAddresses().then(addresses => pIteration.map(addresses, (a) => this.getWeightsStrategyPool(a)));
  }

  async getWeightsStrategyPool(poolAddress) {
    return this.httpWeightsStrategyContract.methods.poolsData(poolAddress).call().then(p => ({
      ...p,
      lastWeightsUpdate: utils.normalizeNumber(p.lastWeightsUpdate),
      address: poolAddress
    }));
  }

  async getWeightStrategyActivePoolsAddresses() {
    return this.httpWeightsStrategyContract.methods.getActivePoolsList().call();
  }

  async getWeightsStrategyReportIntervals() {
    const {min: minReportInterval, max: maxReportInterval} = await this.httpPokerContract.methods.getMinMaxReportIntervals(this.httpWeightsStrategyContract._address).call();
    return {
      minReportInterval: utils.normalizeNumber(minReportInterval),
      maxReportInterval: utils.normalizeNumber(maxReportInterval)
    };
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

  // ==============================================================
  // ZAP
  // ==============================================================

  async getRoundReadyToExecute(key) {
    return this.httpIndicesZapContract.methods.isRoundReadyToExecute(key).call();
  }

  async getRound(key) {
    return this.httpIndicesZapContract.methods.rounds(key).call().then(r => ({
      ...r,
      key,
    }));
  }

  async getReadyToExecuteRounds() {
    const fromBlock = (await this.getCurrentBlock()) - 200000;
    const roundInited = await this.httpIndicesZapContract.getPastEvents('InitRound', { fromBlock });
    const readyToExecute = [];
    await pIteration.forEachSeries(_.chunk(roundInited, 10), (chunk) => {
      return pIteration.forEach(chunk, async (e) => {
        if (await this.getRoundReadyToExecute(e.returnValues.key)) {
          const round = await this.getRound(e.returnValues.key);
          if (round.totalInputAmount.toString() !== '0') {
            readyToExecute.push(round);
          }
        }
      });
    });
    return readyToExecute;
  }

  async filterRoundsToSupply(roundsReadyToExecute) {
    return roundsReadyToExecute.filter(r => r.totalOutputAmount.toString() === '0');
  }

  async filterRoundsToClaim(roundsReadyToExecute) {
    const roundsToClaim = roundsReadyToExecute.filter(r => {
      return r.totalOutputAmount.toString() !== '0' && !utils.gte(r.totalOutputAmountClaimed, r.totalOutputAmount);
    });

    return pIteration.mapSeries(roundsToClaim, async round => {
      const {startBlock, key: roundKey} = round;
      const filter = { fromBlock: startBlock, filter: { roundKey } };
      const [depositedUsers, withdrawals, claimedUsers] = await Promise.all([
        this.httpIndicesZapContract.getPastEvents('Deposit', filter),
        this.httpIndicesZapContract.getPastEvents('Withdraw', filter),
        this.httpIndicesZapContract.getPastEvents('ClaimPoke', filter),
      ]);
      const deposited = {};
      depositedUsers.forEach(d => {
        const user = d.returnValues.user.toLowerCase();
        deposited[user] = utils.add(deposited[user] || '0', d.returnValues.inputAmount);
      })
      withdrawals.forEach(w => {
        const user = w.returnValues.user.toLowerCase();
        deposited[user] = utils.sub(deposited[user] || '0', w.returnValues.inputAmount);
      })
      const claimed = {};
      claimedUsers.forEach(c => {
        claimed[c.returnValues.claimFor.toLowerCase()] = true;
      });
      round.users = _.uniq(depositedUsers.map(d => d.returnValues.user.toLowerCase()).filter(u => !claimed[u] && deposited[u] !== '0'));
      return round;
    }).then(rounds => rounds.filter(r => r.users.length));
  }

  async indicesZapSupplyRedeemPokeFromReporter(roundKeys) {
    roundKeys = roundKeys.slice(0, 1);
    console.log('indicesZapPokeFromReporter', this.currentUserId, roundKeys, this.getPokeOpts());
    return this.sendMethod(
      this.httpIndicesZapContract,
      'supplyAndRedeemPokeFromReporter',
      [this.currentUserId, roundKeys, this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  async indicesZapClaimPokeFromReporter(roundKey, claimForList) {
    console.log('indicesZapClaimPokeFromReporter', roundKey, claimForList);
    return this.sendMethod(
      this.httpIndicesZapContract,
      'claimPokeFromReporter',
      [this.currentUserId, roundKey, claimForList.slice(0, 100), this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  // ==============================================================
  // ORACLE
  // ==============================================================

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
    return this.processSymbols(prices.filter(p => {
      const delta = timestamp - p.timestamp;
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

  async oraclePokeFromSlasher(symbols) {
    console.log('pokeFromSlasher', symbols);
    return this.sendMethod(
      this.httpOracleContract,
      'pokeFromSlasher',
      [this.currentUserId, symbols, this.getPokeOpts()],
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

  async oraclePoke(symbols) {
    console.log('poke', symbols);
    return this.sendMethod(
        this.httpOracleContract,
        'poke',
        [symbols],
        config.poker.privateKey
    );
  }

  async oracleSlasherUpdate() {
    console.log('slasherUpdate');
    return this.sendMethod(
        this.httpOracleContract,
        'slasherUpdate',
        [this.currentUserId],
        config.poker.privateKey
    );
  }

  async oracleSetReporter() {
    console.log('setReporter');
    return this.sendMethod(
        this.httpStackingContract,
        'setReporter',
        [this.currentUserId],
        config.poker.privateKey
    );
  }

  // ==============================================================
  // CVP MAKER
  // ==============================================================

  async getTokenToMakeCvp() {
    const timestamp = await this.getTimestamp();
    let [{min: minReportInterval, max: maxReportInterval}, lastReporterPokeFrom] = await Promise.all([
      this.httpPokerContract.methods.getMinMaxReportIntervals(this.httpCvpMakerContract._address).call(),
      this.httpCvpMakerContract.methods.lastReporterPokeFrom().call().then(r => utils.normalizeNumber(r)),
    ]);
    minReportInterval = utils.normalizeNumber(minReportInterval);
    const diff = timestamp - lastReporterPokeFrom;
    if (diff < minReportInterval){
      return null;
    }

    const cvpAmountOut = await this.httpCvpMakerContract.methods.cvpAmountOut().call().then(r => utils.weiToNumber(r, 18));

    const tokens = [
      '0x38e4adb44ef08f22f5b5b76a8f0c2d0dcbe7dca1', // CVP
      // '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
      // '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e', // YFI
      // '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
      // '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
      // '0x0d438f3b5175bebc262bf23753c1e53d03432bde', // wNXM
      // '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
      '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
      // '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2', // SUSHI
      // '0x2ba592f78db6436527729929aaf6c908497cb200', // CREAM
      // '0x8ab7404063ec4dbcfd4598215992dc3f8ec853d7', // AKRO
      // '0x429881672b9ae42b8eba0e26cd9c73711b891ca5', // PICKLE
      // '0x1ceb5cb57c4d4e2b2433641b95dd330a33185a44', // KP3R
      // '0x3b96d491f067912d18563d56858ba7d6ec67a6fa', // yvCurve-USDN
      // '0x5fa5b62c8af877cb37031e0a3b2f34a78e3c56a6', // yvCurve-LUSD
      // '0x6ede7f19df5df6ef23bd5b9cedb651580bdf56ca', // yvCurve-BUSD
      // '0xc4daf3b5e2a9e93861c3fbdd25f1e943b8d87417', // yvCurve-USDP
      // '0x26607ac599266b21d13c7acf7942c7701a8b699c', // PIPT
      // '0xb4bebd34f6daafd808f73de0d10235a92fbb6c3d', // YETI
      // '0xfa2562da1bba7b954f26c74725df51fb62646313', // ASSY
      // '0x9ba60ba98413a60db4c651d4afe5c937bbd8044b', // YLA
    ];

    let token;
    await pIteration.some(tokens, async (t) => {
      const tContract = new this.httpWeb3.eth.Contract(this.contractsConfig.BPoolAbi, t);
      const tokenBalanceWei = await tContract.methods.balanceOf(this.httpCvpMakerContract._address).call();
      let availableCvpAmount;
      if (t.toLowerCase() === this.cvpAddress) {
        availableCvpAmount = utils.weiToNumber(tokenBalanceWei, 18);
      } else {
        availableCvpAmount = await this.httpUniswapRouterContract.methods.getAmountsOut(
          tokenBalanceWei,
          [t, this.wethAddress, this.cvpAddress]
        ).call().then(wei => utils.weiToNumber(_.last(wei), 18))
      }
      if (availableCvpAmount >= cvpAmountOut) {
        token = t;
        return true;
      }
      return false;
    });
    return token;
  }

  async cvpMakerPokeFromReporter(token) {
    console.log('cvpMakerPokeFromReporter');
    return this.sendMethod(
      this.httpCvpMakerContract,
      'swapFromReporter',
      [this.currentUserId, token, this.getPokeOpts()],
      config.poker.privateKey
    );
  }

  // ==============================================================
  // UTIL
  // ==============================================================

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

  async getGasPriceOptions(gasPriceMul, ) {
    const maxFeePerGas = await this.getGasPrice();
    const gweiGasPrice = parseFloat(utils.weiToGwei(maxFeePerGas.toString()));
    if (gweiGasPrice > parseFloat(config.maxGasPrice)) {
      throw new Error('Max Gas Price: ' + Math.round(gweiGasPrice));
    }
    const maxPriorityFeePerGas = utils.gweiToWei(2 * gasPriceMul);
    return {maxFeePerGas, maxPriorityFeePerGas};
  }

  async getTransaction(method, contractAddress, from, privateKey, nonce = null, gasPriceMul = 1) {
    const encodedABI = method.encodeABI();
    const gasPriceOptions = await this.getGasPriceOptions(gasPriceMul);

    let options: any = { from, ...gasPriceOptions, nonce, data: encodedABI, to: contractAddress };

    if (!options.nonce) {
      options.nonce = await this.httpWeb3.eth.getTransactionCount(from);
    }

    if (typeof options.nonce === "string") {
      options.nonce = this.httpWeb3.utils.hexToNumber(options.nonce);
    }
    console.log('options.nonce', options.nonce);

    let gasWith1Gwei;
    try {
      gasWith1Gwei = Math.round((await method.estimateGas({
        ...options,
        ...gasPriceOptions
      })) * 1.1);
    } catch (e) {
      throw new Error('Revert executing ' + contractAddress + ': ' + e.message + '\n\n' + JSON.stringify(options))
    }

    const needBalance = utils.mul(gasWith1Gwei, gasPriceOptions.maxFeePerGas);
    if(!utils.gte(await this.httpWeb3.eth.getBalance(from), needBalance)) {
      throw new Error('Not enough balance');
    }

    try {
      options.gas = Math.round((await method.estimateGas(options)) * 1.1);
    } catch (e) {
      console.error(e.message);
      throw new Error('Revert executing ' + contractAddress + ': ' + e.message + '\n\n' + JSON.stringify(options))
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

  getFromBlock(contract) {
    return {
      '0x646e846b6ee143bde4f329d4165929bbdcf425f5': 11829480,
      '0x85c6d6b0cd1383cc85e8e36c09d0815daf36b9e9': 12063574
    }[contract._address.toLowerCase()];
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

      const {input: data, gas, gasPrice, to: contractAddress} = tx;
      const weiSpent = utils.mul(gas, gasPrice);
      return {
        gasPriceGwei: Math.round(parseFloat(utils.weiToGwei(gasPrice))),
        ethSpent: utils.weiToEther(weiSpent),
        weiSpent,
        status,
        contractAddress,
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

  async getNetworkId() {
    return utils.normalizeNumber(await this.httpWeb3.eth.net.getId());
  }

  async getEthBalance(userAddress) {
    return utils.weiToEther(await this.httpWeb3.eth.getBalance(userAddress));
  }

  async getTimestamp() {
    const lastBlockNumber = (await this.getCurrentBlock()) - 1;
    return this.getBlockTimestamp(lastBlockNumber).catch((e) => {
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
      const web3GasPriceGwei = utils.weiToGwei((await this.httpWeb3.eth.getGasPrice()).toString(10));
      try {
        const { data: gasData } = await axios.get('https://etherchain.org/api/gasPriceOracle');
        let gasPrice = parseFloat(gasData.standard);
        gasPrice = web3GasPriceGwei / 2 > gasPrice ? web3GasPriceGwei : gasPrice + 5;
        console.log('gasPrice', gasPrice, 'web3GasPriceGwei', web3GasPriceGwei, 'gasData', gasData);
        return utils.gweiToWei(gasPrice);
      } catch (e) {
        return utils.gweiToWei(web3GasPriceGwei);
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
}
