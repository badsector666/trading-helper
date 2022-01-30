interface IExchange {
  getFreeAsset(assetName: string): number

  marketBuy(symbol: ExchangeSymbol, cost: number): TradeResult

  marketSell(symbol: ExchangeSymbol, quantity?: number): TradeResult

  getPrice(symbol: ExchangeSymbol): number
}

class Binance implements IExchange {
  private static readonly API = "https://api.binance.com/api/v3";
  private readonly key: string;
  private readonly secret: string;
  private readonly tradeReqParams: object;
  private readonly reqParams: object;
  private readonly priceCache: Map<string, number>;

  constructor(store: IStore) {
    this.key = store.get('KEY')
    this.secret = store.get('SECRET')
    this.tradeReqParams = {method: 'post', headers: {'X-MBX-APIKEY': this.key}}
    this.reqParams = {headers: {'X-MBX-APIKEY': this.key}}
    this.priceCache = new Map()
  }

  getPrice(symbol: ExchangeSymbol): number {
    const resource = "ticker/price"
    const query = `symbol=${symbol}`;
    const data = execute({
      context: `${Binance.API}/${resource}?${query}`, interval: 1000, attempts: 60,
      runnable: ctx => UrlFetchApp.fetch(ctx, this.reqParams)
    });
    Log.debug(data.getContentText())
    const price = +JSON.parse(data.getContentText()).price;
    this.priceCache.set(symbol.toString(), price)
    return price
  }

  getFreeAsset(assetName: string): number {
    const resource = "account"
    const query = "";
    const data = execute({
      context: `${Binance.API}/${resource}`, interval: 1000, attempts: 60,
      runnable: ctx => UrlFetchApp.fetch(`${ctx}?${this.addSignature(query)}`, this.reqParams)
    });
    try {
      const account = JSON.parse(data.getContentText());
      const assetVal = account.balances.find((balance) => balance.asset == assetName);
      Log.debug(assetVal)
      return assetVal ? +assetVal.free : 0
    } catch (e) {
      Log.error(e)
    }
    return 0
  }

  marketBuy(symbol: ExchangeSymbol, cost: number): TradeResult {
    const moneyAvailable = this.getFreeAsset(symbol.priceAsset)
    if (moneyAvailable < cost) {
      return TradeResult.fromMsg(symbol, `Not enough money to buy: ${symbol.priceAsset}=${moneyAvailable}`)
    }
    Log.info(`Buying ${symbol}`);
    const query = `symbol=${symbol}&type=MARKET&side=BUY&quoteOrderQty=${cost}`;
    const tradeResult = this.marketTrade(query);
    tradeResult.symbol = symbol
    tradeResult.paid = tradeResult.cost
    return tradeResult;
  }

  /**
   * Sells specified quantity or all available asset.
   * @param symbol
   * @param quantity
   */
  marketSell(symbol: ExchangeSymbol, quantity?: number): TradeResult {
    let query;
    if (quantity) {
      query = `symbol=${symbol}&type=MARKET&side=SELL&quantity=${quantity}`;
    } else {
      const freeAsset = this.getFreeAsset(symbol.quantityAsset)
      const price = this.priceCache.get(symbol.toString()) || this.getPrice(symbol);
      const quoteQty = Math.floor(price * freeAsset)
      if (quoteQty <= 10) { // Binance order limit in USD
        return TradeResult.fromMsg(symbol, `Account has insufficient balance for ${symbol.quantityAsset}: free=${freeAsset}, ${symbol.priceAsset}=${quoteQty}`)
      }
      query = `symbol=${symbol}&type=MARKET&side=SELL&quoteOrderQty=${quoteQty}`;
    }
    Log.info(`Selling ${symbol}`);
    try {
      const tradeResult = this.marketTrade(query);
      tradeResult.symbol = symbol
      tradeResult.gained = tradeResult.cost
      return tradeResult;
    } catch (e) {
      if (e.message.includes("Account has insufficient balance")) {
        return TradeResult.fromMsg(symbol, `Account has insufficient balance for ${symbol.quantityAsset}`)
      }
      throw e
    }
  }

  marketTrade(query: string): TradeResult {
    const response = execute({
      context: `${Binance.API}/order`, interval: 1000, attempts: 60,
      runnable: ctx => UrlFetchApp.fetch(`${ctx}?${this.addSignature(query)}`, this.tradeReqParams)
    });
    Log.debug(response.getContentText())
    try {
      const order = JSON.parse(response.getContentText());
      const tradeResult = new TradeResult();
      const price = order.fills && order.fills[0] && order.fills[0].price
      tradeResult.quantity = +order.origQty
      tradeResult.cost = +order.cummulativeQuoteQty
      tradeResult.price = +price
      tradeResult.fromExchange = true
      return tradeResult;
    } catch (e) {
      Log.error(e)
      throw e
    }
  }

  private addSignature(data: string) {
    const timestamp = Number(new Date().getTime()).toFixed(0);
    const sigData = `${data}${data ? "&" : ""}timestamp=${timestamp}`
    const sig = Utilities.computeHmacSha256Signature(sigData, this.secret).map(e => {
      const v = (e < 0 ? e + 256 : e).toString(16);
      return v.length == 1 ? "0" + v : v;
    }).join("")

    return `${sigData}&signature=${sig}`
  }
}
