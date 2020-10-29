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

import {IPowerOracleStorage} from "./interface";

const utils = require('../utils');

const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite'
});

const KeyValue = sequelize.define('KeyValue', {
    key: {
        type: DataTypes.STRING(100)
    },
    value: {
        type: DataTypes.TEXT
    }
}, {
    indexes: [{ unique: true, fields: ['key'] }]
});

module.exports = async () => {
    const storage = new PowerOracleStorage();
    await storage.init();
    return storage;
};

class PowerOracleStorage implements IPowerOracleStorage {
    constructor() {}

    async init() {
        await KeyValue.sync();
    }

    async getValue(key) {
        const instance = await KeyValue.findOne({where: {key}});
        return instance ? instance.value : null;
    }

    async setValue(key, value) {
        value = value.toString();
        const instance = await KeyValue.findOne({where: {key}});
        return instance ? KeyValue.update({value}, {where: {key}}) : KeyValue.create({key, value});
    }

    async increaseFloatValue(key, value) {
        value = parseFloat(value);
        const oldValue = await this.getValue(key).then(res => parseFloat(res) || 0);
        const valueToSet = oldValue + value;
        await this.setValue(key, valueToSet);
        return valueToSet;
    }

    async increaseBnValue(key, value) {
        const oldValue = await this.getValue(key).then(res => res || '0');
        const valueToSet = utils.add(oldValue, value);
        await this.setValue(key, valueToSet);
        return valueToSet;
    }
}
