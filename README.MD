# Power Oracle Reporter
Script for working with Power Oracle contracts, which allows updating prices and slash the primary Price Reporter's deposit in CVP in case it did not update prices on time.

## Starting Power Oracle Reporter
Kovan Testnet:
```
yarn
POKER_PRIVATE_KEY=<Reporter private key e.g. 0x7700fa638003ef53c10485c0535353e9cf7e773cf64b3cfc7942662f8218e88b> npm start
```
Ethereum Main Network:
```
yarn
MAINNET=1 POKER_PRIVATE_KEY=<Reporter private key e.g. 0x7700fa638003ef53c10485c0535353e9cf7e773cf64b3cfc7942662f8218e88b> npm start
```

## Run in background
```
yarn global add pm2 && pm2 install typescript
MAINNET=1 POKER_PRIVATE_KEY=<Reporter private key e.g. 0x7700fa638003ef53c10485c0535353e9cf7e773cf64b3cfc7942662f8218e88b> pm2 start index.ts --name "power-oracle-reporter"
pm2 save && sudo pm2 startup # add to startup
```

## ETH compensation
To enable CVP compensation converting to ETH and sending to poker address you can add COMPENSATE_ETH=1 option to start script command.

# Telegram bot
Use a telegram bot to receive information about a change in your status (Price Reporter or Fisherman), the need to replenish the Reporter address balance in ETH, slashing, and others.

## Getting started with personal notifier telegram bot
1. Go to https://t.me/BotFather and create a new bot with any name. It will be your bot
2. Copy access token and paste to TG_KEY argument
3. Get your telegram user id. You can google how to get it or use one of the popular bots: https://t.me/myTelergamIdBot, https://t.me/userinfobot
4. Paste your telegram user id to the TG_ADMIN argument. You can specify several admins separated by comma.
5. As a result, your command for running the bot will look like this:
```
TG_KEY=1112233444:AAEV2fJbf1ba-vbftCP-knd2dg0t3wq-gya TG_ADMIN=555444333 MAINNET=1 POKER_PRIVATE_KEY=0x7700fa638003ef53c10485c0535353e9cf7e773cf64b3cfc7942662f8218e88b npm start
```
6. Open your telegram bot and press start. You will receive notifications
