// Declaring the runtime context which holds the above functions.
const _runtimeCtx = this;

// @ts-ignore
AppScriptExecutor.SetContext({
  runtimeCtx: _runtimeCtx,
  debugMsg: (arg) => Log.debug(arg)
})

// @ts-ignore
const StopLossWatcher = AppScriptExecutor.New({
  tasksGetter: {
    get() {
      return [{
        isValid: () => true,
        getTaskName: () => "StopLossCheck",
        getScheduledTimestamp: () => Date.now() - 1000,
        execute(args) {
          const store = new DefaultStore(PropertiesService.getScriptProperties())
          let sendLog = true;
          try {
            const exchangeResults = new V2Trader(store, new Binance(store)).stopLoss().filter(r => r.fromExchange);
            sendLog = exchangeResults.length > 0
            exchangeResults.forEach(r => Log.info(r));
          } catch (e) {
            Log.error(e)
          }
          if (sendLog) {
            Log.ifUsefulDumpAsEmail()
          }
        }
      }];
    }
  }
})


/**
 * StopLossWatcher starts automatically by the V2Trader in {@link V2Trader.buy}.
 * Also, it stops in ${@link V2Trader.stopLoss} if no active trades to watch left.
 *
 * You don't need to start it manually unless there's some reason.
 */
function Start() {
  try {
    // @ts-ignore
    // workaround: no-op function to not run the tasks on restart
    _runtimeCtx[AppScriptExecutor.INSTANCE_NAME] = () => {
    }
    StopLossWatcher.restart();
    Log.info(StopLossWatcher.getTasks().map(t => t.getTaskName()));
  } finally {
    Log.ifUsefulDumpAsEmail()
  }
}
