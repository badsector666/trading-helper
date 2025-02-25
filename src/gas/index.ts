import { CachedStore, DefaultStore, FirebaseStore } from "./Store";
import { Statistics } from "./Statistics";
import { Log, SECONDS_IN_MIN, TICK_INTERVAL_MIN } from "./Common";
import {
  type AppState,
  type CandidateInfo,
  type CandidatesData,
  type CoinName,
  type Config,
  f0,
  f2,
  type InitialSetupParams,
  type IStore,
  Key,
  MASK,
} from "../lib";
import { Process } from "./Process";
import { CacheProxy } from "./CacheProxy";
import { TradesDao } from "./dao/Trades";
import { ConfigDao } from "./dao/Config";
import { TradeManager } from "./TradeManager";
import { Updater, UpgradeDone } from "./Updater";
import { type TraderPlugin } from "./traders/plugin/api";
import { WithdrawalsManager } from "./WithdrawalsManager";
import { CandidatesDao } from "./dao/Candidates";
import { Binance } from "./Binance";
import HtmlOutput = GoogleAppsScript.HTML.HtmlOutput;
import { MarketDataDao } from "./dao/MarketData";

function doGet(): HtmlOutput {
  return catchError(() => {
    return (
      HtmlService.createTemplateFromFile(`index`)
        .evaluate()
        .setFaviconUrl(
          `https://user-images.githubusercontent.com/7527778/167810306-0b882d1b-64b0-4fab-b647-9c3ef01e46b4.png`
        )
        .addMetaTag(
          `viewport`,
          `width=device-width, initial-scale=1, maximum-scale=1`
        )
        // @ts-expect-error VERSION is injected by esbuild
        .setTitle(`TradingHelper v${VERSION}`)
    );
  });
}

function doPost(): HtmlOutput {
  return HtmlService.createHtmlOutput().setTitle(`Not found`);
}

const skipNextTick = `skipNextTick`;

function tick(): void {
  catchError(() => {
    if (CacheProxy.get(skipNextTick)) return;
    Process.tick();
  });
}

function start(): string {
  return catchError(startAllProcesses);
}

function stop(): string {
  return catchError(stopTradingProcess);
}

function startAllProcesses(): string {
  ScriptApp.getProjectTriggers().forEach((t) => {
    ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(Process.tick.name)
    .timeBased()
    .everyMinutes(TICK_INTERVAL_MIN)
    .create();
  ScriptApp.newTrigger(Updater.upgrade.name).timeBased().everyHours(6).create();
  ScriptApp.newTrigger(DefaultStore.keepCacheAlive.name)
    .timeBased()
    .everyHours(3)
    .create();
  Log.alert(
    `ℹ️ Background processes started. State synchronization interval is ${TICK_INTERVAL_MIN} minute.`
  );
  return `OK`;
}

function stopTradingProcess(): string {
  let deleted = false;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === Process.tick.name) {
      ScriptApp.deleteTrigger(t);
      deleted = true;
    }
  });
  deleted && Log.alert(`⛔ Trading process stopped.`);
  return `OK`;
}

function catchError<T>(fn: () => T): T {
  try {
    const res = fn();
    Log.ifUsefulDumpAsEmail();
    return res;
  } catch (e) {
    const awsLimit = `ConcurrentInvocationLimitExceeded`;
    if (e.message.includes(awsLimit)) {
      // try again after small delay
      Utilities.sleep(500 + new Date().getMilliseconds());
      return catchError(fn);
    }
    const limitMsg1 = `Service invoked too many times`;
    const limitMsg2 = `Please wait a bit and try again`;
    if (e.message.includes(limitMsg1) || e.message.includes(limitMsg2)) {
      // If limit already handled, just throw the error without logging
      if (CacheProxy.get(skipNextTick)) throw e;
      // Handle limit gracefully
      Log.alert(`ℹ️Google API daily rate limit exceeded.`);
      const minutes = 5;
      CacheProxy.put(skipNextTick, `true`, SECONDS_IN_MIN * minutes);
      Log.alert(`ℹ️Background process paused for the next ${minutes} minutes.`);
    }
    Log.error(e);
    Log.ifUsefulDumpAsEmail();
    throw e;
  }
}

function initialSetup(params: InitialSetupParams): string {
  return catchError(() => {
    let store: IStore = DefaultStore;
    if (params.dbURL) {
      const fbStore = new FirebaseStore();
      fbStore.connect(params.dbURL);
      Log.alert(`Connected to Firebase: ${params.dbURL}`);
      store = new CachedStore(fbStore, CacheProxy);
    }
    const config = new ConfigDao(store).update((config) => {
      config.KEY = params.binanceAPIKey ?? config.KEY;
      config.SECRET = params.binanceSecretKey ?? config.SECRET;
      config.ViewOnly = params.viewOnly;
      return config;
    });
    if (config.ViewOnly || (config.KEY && config.SECRET)) {
      startAllProcesses();
    }
    Log.alert(`✨ Initial setup done.`);
    return `OK`;
  });
}

function sellAll(): string {
  return catchError(() => {
    TradeManager.default().sellAll();
    return Log.printInfos();
  });
}

function remove(...coins: CoinName[]): string {
  return catchError(() => {
    const dao = new TradesDao(DefaultStore);
    coins?.forEach((c) => {
      dao.update(c, (trade) => {
        trade.deleted = true;
        return trade;
      });
    });
    return `Removed ${coins?.join(`, `)}`;
  });
}

function setConfig(config: Config): { msg: string; config: Config } {
  return catchError(() => {
    let msg = `Config updated`;
    const dao = new ConfigDao(DefaultStore);
    dao.update((cfg) => {
      if (cfg.StableBalance <= 0 && config.StableBalance > 0) {
        // Check the balance is actually present on Spot balance
        const balance = new Binance(dao).getBalance(config.StableCoin);
        if (balance < config.StableBalance) {
          msg = `\nActual balance on your Binance Spot account is $${f2(
            balance
          )}, which is less than $${
            config.StableBalance
          } you are trying to set. You might need to transfer money from the Funding account. Check the balances and try again.`;
          config.StableBalance = cfg.StableBalance;
        }
      }
      return config;
    });
    return { msg, config };
  });
}

function setFirebaseURL(url: string): string {
  return catchError(() => {
    if (url) {
      new FirebaseStore().connect(url);
      Log.alert(`Connected to Firebase: ${url}`);
      return `OK`;
    } else {
      new FirebaseStore().disconnect();
      Log.alert(`Disconnected from Firebase`);
      return `OK`;
    }
  });
}

function getConfig(): Config {
  const configDao = new ConfigDao(DefaultStore);
  const config = configDao.get();
  config.KEY = config.KEY ? MASK : ``;
  config.SECRET = config.SECRET ? MASK : ``;
  return config;
}

const plugin: TraderPlugin = global.TradingHelperLibrary;

function getCandidates(): CandidatesData {
  const mktData = new MarketDataDao(DefaultStore);
  const candidatesDao = new CandidatesDao(DefaultStore);
  const { all, selected } = plugin.getCandidates(candidatesDao);
  // Add pinned candidates
  const other = {};
  Object.keys(all).forEach((coin) => {
    const ci = all[coin];
    if (ci[Key.PINNED] || (ci[Key.IMBALANCE] && ci[Key.IMBALANCE] > 0.3)) {
      other[coin] = ci;
    }
  });
  const { average: averageDemand, accuracy } =
    candidatesDao.getAverageImbalance(all);
  const strength = mktData.getStrength(averageDemand);
  return {
    selected,
    other,
    marketInfo: { averageDemand, accuracy, strength },
  };
}

/**
 * Returns the aggregated state for the UI:
 * trades, config, statistics, candidates
 */
function getState(): AppState {
  return {
    config: getConfig(),
    firebaseURL: FirebaseStore.url,
    info: new Statistics(DefaultStore).getAll(),
    candidates: getCandidates(),
    assets: new TradesDao(DefaultStore).getList(),
  };
}

function buy(coin: CoinName): string {
  return catchError(() => {
    TradeManager.default().buy(coin.toUpperCase());
    return Log.printInfos() || `In progress!`;
  });
}

function sell(...coins: CoinName[]): string {
  return catchError(() => {
    const mgr = TradeManager.default();
    coins?.forEach((c) => {
      mgr.sell(c.toUpperCase());
    });
    return Log.printInfos();
  });
}

function importCoin(coin: CoinName, qty?: number): any {
  return catchError(() => {
    TradeManager.default().import(coin, qty);
    return Log.printInfos();
  });
}

function addWithdrawal(amount: number): string {
  return catchError(() => {
    if (!isFinite(+amount)) throw new Error(`Amount is not a number.`);

    const configDao = new ConfigDao(DefaultStore);
    const mgr = new WithdrawalsManager(
      configDao,
      new Binance(configDao),
      new Statistics(DefaultStore)
    );
    const { balance } = mgr.addWithdrawal(amount);
    const msg = `💳 Withdrawal of $${amount} was added to the statistics and the balance was updated. Current balance: $${balance}.`;
    Log.alert(msg);
    return Log.printInfos();
  });
}

global.doGet = doGet;
global.doPost = doPost;
global.tick = tick;
global.start = start;
global.stop = stop;
global.initialSetup = initialSetup;
global.setConfig = setConfig;
global.setFirebaseURL = setFirebaseURL;
global.buy = buy;
global.sell = sell;
global.sellAll = sellAll;
global.remove = remove;
global.importCoin = importCoin;
global.addWithdrawal = addWithdrawal;
global.getState = getState;
global.keepCacheAlive = () => {
  catchError(() => {
    DefaultStore.keepCacheAlive();
  });
};
global.upgrade = () => {
  return catchError(() => {
    const result = Updater.upgrade();
    result.includes(UpgradeDone) && startAllProcesses();
    return result;
  });
};
global.info = (coin: CoinName) => {
  coin = coin?.toUpperCase();

  const candidatesDao = new CandidatesDao(DefaultStore);
  if (!coin) {
    const { average, accuracy } = candidatesDao.getAverageImbalance();
    return `The current market is ${average > 0 ? `BULLISH` : `BEARISH`}.
Average demand (-100..100): ${f0(average * 100)}%
Accuracy (0..100): ${f0(accuracy * 100)}%${
      accuracy < 0.5
        ? ` (automatically improved over time for TH+ subscribers)`
        : ``
    }`;
  }

  let result = ``;

  candidatesDao.update((all) => {
    const ci = all[coin];
    if (!ci) {
      result = `${coin} is not tracked as a candidate; either it does not exist or it lacks historical price data yet.`;
    }

    const imbalance = plugin.getImbalance(coin, ci);
    ci[Key.IMBALANCE] = imbalance;

    const curRange = `${f0(ci?.[Key.MIN_PERCENTILE] * 100)}-${f0(
      ci?.[Key.MAX_PERCENTILE] * 100
    )}`;
    result = `Strength (0..100): ${f0(ci?.[Key.STRENGTH] * 100)}
Demand (-100..100): ${f0(imbalance * 100)}%
Support: ${ci?.[Key.MIN]}
Resistance: ${ci?.[Key.MAX]}
Current price zone (-|0..100|+): ${curRange}%`;

    return all;
  });
  return result;
};
global.getImbalance = (coin: CoinName, ci?: CandidateInfo) => {
  const candidatesDao = new CandidatesDao(DefaultStore);
  const imbalance = plugin.getImbalance(coin, ci || candidatesDao.get(coin));

  if (ci) {
    if (imbalance) {
      candidatesDao.update((all) => {
        all[coin][Key.IMBALANCE] = imbalance;
        return all;
      });
    }
  } else {
    new TradesDao(DefaultStore).update(coin, (tm) => {
      tm.supplyDemandImbalance = imbalance;
      return tm;
    });
  }

  return imbalance;
};
global.pin = (coin: CoinName, value = true) => {
  coin = coin.toUpperCase();
  new CandidatesDao(DefaultStore).pin(coin, value);
  return Log.printInfos();
};

const helpDescriptions = {
  start: `Starts all background processes.`,
  stop: `Stops the trading process.`,
  info: `Returns information about the market or a coin. Examples: 1) $ info 2) $ info BTC`,
  pin: `Pins a candidate. Example: $ pin BTC`,
  buy: `Buys a coin. Example: $ buy BTC`,
  sell: `Sells a list of coins. Example: $ sell BTC ETH`,
  sellAll: `Sells all coins.`,
  remove: `Removes a list of coins from the trade list. Example: $ remove BTC ETH`,
  importCoin: `Imports a coin from the Binance Spot portfolio. Imports all or the specified amount. Example: $ importCoin BTC [amount]`,
  addWithdrawal: `Adds a withdrawal to the statistics. Example: $ addWithdrawal 100`,
  upgrade: `Upgrades the system.`,
};

global.help = (): string => {
  return Object.entries(helpDescriptions)
    .map(([funcName, description]) => `${funcName}: ${description}`)
    .join(`\n`);
};
