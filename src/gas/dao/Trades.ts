import { IStore, TradeMemo, TradeState } from "../../lib"
import { isNode } from "browser-or-node"

export class TradesDao {
  private memCache: { [p: string]: TradeMemo }

  constructor(private readonly store: IStore) {}

  has(coinName: string): boolean {
    return !!this.get()[coinName]
  }

  /**
   * update function provides a way to update the trade memo object.
   *
   * It locks the trade memo object for the duration of the mutation function but no more than 30 seconds.
   *
   * It expects a coinName and a mutate function. The mutate function receives either an existing trade memo object
   * from a store or if not found, calls the optional notFoundFn callback.
   *
   * Mutation function can return an updated trade memo object or undefined/null value.
   * If returned trade memo object has deleted flag set to true, this trade memo will be deleted.
   * If undefined/null value is returned, the trade memo will not be updated.
   *
   * @param coinName
   * @param mutateFn
   * @param notFoundFn?
   */
  update(
    coinName: string,
    mutateFn: (tm: TradeMemo) => TradeMemo | undefined | null,
    notFoundFn?: () => TradeMemo | undefined,
  ): void {
    coinName = coinName.toUpperCase()
    const trade = this.get()[coinName]
    // if trade exists - get result from mutateFn, otherwise call notFoundFn if it was provided
    // otherwise changedTrade is null.
    const changedTrade = trade ? mutateFn(trade) : notFoundFn ? notFoundFn() : null

    if (changedTrade) {
      changedTrade.deleted ? this.#delete(changedTrade) : this.#set(changedTrade)
    }
  }

  iterate(mutateFn: (tm: TradeMemo) => TradeMemo | undefined | null): void {
    const trades = this.get()
    Object.values(trades).forEach((tm) => {
      const changedTrade = mutateFn(tm)
      if (changedTrade) {
        changedTrade.deleted ? this.#delete(changedTrade) : this.#set(changedTrade)
      }
    })
  }

  get(): { [p: string]: TradeMemo } {
    if (isNode && this.memCache) {
      // performance optimization for back-testing
      return this.memCache
    }

    const trades = this.store.getOrSet(`Trades`, {})
    // Convert raw trades to TradeMemo objects
    const tradeMemos = Object.keys(trades).reduce((acc, key) => {
      acc[key] = TradeMemo.fromObject(trades[key])
      return acc
    }, {} as { [p: string]: TradeMemo })

    this.memCache = tradeMemos
    return tradeMemos
  }

  getList(state?: TradeState): TradeMemo[] {
    const values = Object.values(this.get())
    return state ? values.filter((trade) => trade.stateIs(state)) : values
  }

  #set(tradeMemo: TradeMemo) {
    const trades = this.get()
    trades[tradeMemo.tradeResult.symbol.quantityAsset] = tradeMemo
    this.store.set(`Trades`, trades)
  }

  #delete(tradeMemo: TradeMemo) {
    const trades = this.get()
    delete trades[tradeMemo.tradeResult.symbol.quantityAsset]
    this.store.set(`Trades`, trades)
  }
}
