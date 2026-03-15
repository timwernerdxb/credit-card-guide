const api = require('./api');
const config = require('./config');
const store = require('./store');

// ============================================
// Trading Strategy Engine
//
// Strategies:
//   "value"  — Buy outcomes priced far from estimated fair value
//              using volume-weighted signals and mean reversion
//   "spread" — Market-make by placing limit orders around midpoint
// ============================================

class Strategy {
  constructor() {
    this.positions = new Map();  // tokenId -> { side, size, avgPrice, marketQuestion }
    this.tradeLog = [];
    this.pnl = 0;
    this.totalInvested = 0;
    this.unrealizedPnl = 0;
    this.stats = {
      scans: 0,
      tradesPlaced: 0,
      ordersPlaced: 0,
      errors: 0,
      lastScan: null,
      startedAt: new Date().toISOString(),
    };
  }

  // ---- Restore state from persistent storage ----
  restore() {
    const saved = store.getStrategyState();
    if (!saved || !saved.stats) return;

    if (saved.positions && saved.positions.length > 0) {
      this.positions = new Map();
      for (const p of saved.positions) {
        // Skip stale synced positions — only keep positions the bot actually opened
        if (p.synced) continue;
        this.positions.set(p.tokenId, {
          marketId: p.marketId,
          question: p.question,
          side: p.side,
          size: p.size,
          avgPrice: p.avgPrice,
          entryTime: p.entryTime,
          edge: p.edge,
          negRisk: p.negRisk,
        });
      }
    }

    this.tradeLog = saved.tradeLog || [];
    this.pnl = saved.pnl || 0;

    // Recalculate invested from actual positions (not stale stored value)
    this.totalInvested = 0;
    for (const [, pos] of this.positions.entries()) {
      this.totalInvested += (pos.avgPrice || 0) * (pos.size || 0);
    }

    if (saved.stats) {
      this.stats = { ...this.stats, ...saved.stats };
    }
    console.log(`[STRATEGY] Restored: ${this.positions.size} positions, P&L: $${this.pnl.toFixed(2)}, invested: $${this.totalInvested.toFixed(2)}`);
  }

  // ---- Persist current state ----
  persist() {
    const positionsArray = [];
    for (const [tokenId, pos] of this.positions.entries()) {
      positionsArray.push({ tokenId, ...pos });
    }
    store.setStrategyState({
      positions: positionsArray,
      tradeLog: this.tradeLog,
      pnl: this.pnl,
      totalInvested: this.totalInvested,
      stats: this.stats,
    });
  }

  // ---- Sync P&L from Polymarket API trade history ----
  // ONLY calculates realized P&L from sells. Does NOT add positions.
  // Positions are tracked by the bot when it places trades and persisted to disk.
  async syncFromAPI() {
    console.log('[SYNC] Calculating realized P&L from Polymarket trade history...');

    // Clear ALL restored positions — they're unreliable from old syncs.
    // Bot will only track positions it opens from now on.
    if (this.positions.size > 0) {
      console.log(`[SYNC] Clearing ${this.positions.size} stale restored positions`);
      this.positions.clear();
      this.totalInvested = 0;
    }

    try {
      const rawResult = await api.getTrades();

      // Handle different response formats
      let trades;
      if (Array.isArray(rawResult)) {
        trades = rawResult;
      } else if (rawResult && typeof rawResult === 'object') {
        const arrayKey = ['data', 'trades'].find(k => Array.isArray(rawResult[k]))
          || Object.keys(rawResult).find(k => Array.isArray(rawResult[k]));
        trades = arrayKey ? rawResult[arrayKey] : null;
      }

      if (!trades || trades.length === 0) {
        console.log('[SYNC] No trades found');
        return;
      }

      console.log(`[SYNC] Found ${trades.length} trades, calculating P&L...`);

      // Build net position per tokenId
      const netPositions = new Map();

      for (const trade of trades) {
        const tokenId = trade.asset_id;
        const takerSide = (trade.side || '').toUpperCase();
        const role = (trade.trader_side || '').toUpperCase();
        // Flip side if we're the maker (side = taker's direction, not ours)
        const ourSide = role === 'MAKER'
          ? (takerSide === 'BUY' ? 'SELL' : 'BUY')
          : takerSide;
        const size = parseFloat(trade.size || 0);
        const price = parseFloat(trade.price || 0);

        if (!tokenId || size <= 0 || price <= 0) continue;

        if (!netPositions.has(tokenId)) {
          netPositions.set(tokenId, { bought: 0, sold: 0, totalCost: 0, totalRevenue: 0 });
        }

        const pos = netPositions.get(tokenId);
        if (ourSide === 'BUY') {
          pos.bought += size;
          pos.totalCost += size * price;
        } else if (ourSide === 'SELL') {
          pos.sold += size;
          pos.totalRevenue += size * price;
        }
      }

      // Calculate realized P&L from closed portions only
      let syncedPnl = 0;
      let sellCount = 0;

      for (const [tokenId, pos] of netPositions.entries()) {
        if (pos.sold > 0 && pos.bought > 0) {
          const avgBuyPrice = pos.totalCost / pos.bought;
          const avgSellPrice = pos.totalRevenue / pos.sold;
          const pnl = (avgSellPrice - avgBuyPrice) * pos.sold;
          syncedPnl += pnl;
          sellCount++;
          if (Math.abs(pnl) > 0.01) {
            console.log(`[SYNC] Realized: $${pnl.toFixed(2)} on token ${tokenId.substring(0, 16)}... (buy ${avgBuyPrice.toFixed(3)} → sell ${avgSellPrice.toFixed(3)}, ${pos.sold.toFixed(1)} shares)`);
          }
        }
      }

      console.log(`[SYNC] Total realized P&L: $${syncedPnl.toFixed(2)} from ${sellCount} tokens with sells`);
      console.log(`[SYNC] Stored P&L: $${this.pnl.toFixed(2)}, Positions: ${this.positions.size} (from bot tracking)`);

      // Only update P&L if sync found sell data and it's more than stored
      if (syncedPnl !== 0 && Math.abs(syncedPnl) > Math.abs(this.pnl)) {
        console.log(`[SYNC] Updating P&L: $${this.pnl.toFixed(2)} → $${syncedPnl.toFixed(2)}`);
        this.pnl = syncedPnl;
      }

      this.persist();
    } catch (err) {
      console.error('[SYNC] Error:', err.message);
    }
  }

  // ---- Scan markets for opportunities ----
  async scan() {
    this.stats.scans++;
    this.stats.lastScan = new Date().toISOString();

    const strategyName = config.strategy;
    console.log(`[SCAN #${this.stats.scans}] Running "${strategyName}" strategy...`);

    try {
      const markets = await api.getMarkets({ limit: 50 });
      const opportunities = [];

      for (const market of markets) {
        if (market.closed || !market.active) continue;
        if (!market.clobTokenIds || market.clobTokenIds.length < 2) continue;

        try {
          const parsed = this.parseMarket(market);
          if (!parsed) continue;

          const signal = this.evaluateMarket(parsed);
          if (signal) {
            opportunities.push(signal);
          }
        } catch (err) {
          continue;
        }
      }

      // Sort by edge (highest first) and take top N
      opportunities.sort((a, b) => b.edge - a.edge);
      const topPicks = opportunities.slice(0, config.maxOpenPositions);

      console.log(`[SCAN] Found ${opportunities.length} opportunities, taking top ${topPicks.length}`);

      for (const opp of topPicks) {
        if (this.positions.size >= config.maxOpenPositions) {
          console.log('[SCAN] Max positions reached, skipping');
          break;
        }

        if (this.totalInvested + config.tradeAmountUsdc > config.maxPositionUsdc * config.maxOpenPositions) {
          console.log('[SCAN] Max total investment reached, skipping');
          break;
        }

        // Don't double up on same market
        if (this.positions.has(opp.tokenId)) continue;

        await this.executeTrade(opp);
      }
    } catch (err) {
      this.stats.errors++;
      console.error('[SCAN] Error:', err.message);
    }

    this.persist();
  }

  // ---- Parse market data into usable format ----
  parseMarket(market) {
    let prices;
    try {
      prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
    } catch {
      return null;
    }

    if (!prices || prices.length < 2) return null;

    const yesPrice = parseFloat(prices[0]);
    const noPrice = parseFloat(prices[1]);

    if (isNaN(yesPrice) || isNaN(noPrice)) return null;
    if (yesPrice <= 0.02 || yesPrice >= 0.98) return null; // Skip near-resolved

    const tokenIds = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds;

    return {
      id: market.id,
      conditionId: market.conditionId,
      question: market.question,
      category: market.category,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      yesPrice,
      noPrice,
      volume24h: parseFloat(market.volume24hr || 0),
      volumeTotal: parseFloat(market.volume || 0),
      liquidity: parseFloat(market.liquidity || 0),
      endDate: market.endDate,
      negRisk: market.negRisk || false,
    };
  }

  // ---- Evaluate a market for trading signals ----
  evaluateMarket(market) {
    if (config.strategy === 'spread') {
      return this.evaluateSpread(market);
    }
    return this.evaluateValue(market);
  }

  // ---- Value strategy: look for mispriced outcomes ----
  evaluateValue(market) {
    // Skip low-liquidity markets (hard to exit)
    if (market.liquidity < 10000) return null;
    // Skip low-volume markets (stale prices)
    if (market.volume24h < 5000) return null;

    const yesPrice = market.yesPrice;
    const noPrice = market.noPrice;

    let side = null;
    let targetPrice = null;
    let edge = 0;

    // Buy the cheaper side in the 0.10-0.40 range for high volume markets
    // These often offer value because the crowd overweights the favorite
    if (yesPrice >= 0.10 && yesPrice <= 0.40 && market.volume24h > 20000) {
      side = 'yes';
      targetPrice = yesPrice;
      edge = (1 / yesPrice - 1) * 0.1;
    } else if (noPrice >= 0.10 && noPrice <= 0.40 && market.volume24h > 20000) {
      side = 'no';
      targetPrice = noPrice;
      edge = (1 / noPrice - 1) * 0.1;
    }

    // Mean reversion: if yes is 0.55-0.75, the "no" side might be underpriced
    if (!side && yesPrice >= 0.55 && yesPrice <= 0.75) {
      side = 'no';
      targetPrice = noPrice;
      edge = (noPrice - 0.01) * 0.15;
    }

    if (!side || edge < config.minEdge) return null;

    return {
      marketId: market.id,
      question: market.question,
      tokenId: side === 'yes' ? market.yesTokenId : market.noTokenId,
      side,
      price: targetPrice,
      edge,
      liquidity: market.liquidity,
      volume24h: market.volume24h,
      negRisk: market.negRisk,
    };
  }

  // ---- Spread strategy: market-make around midpoint ----
  evaluateSpread(market) {
    if (market.liquidity < 50000) return null;
    if (market.volume24h < 10000) return null;

    const spread = Math.abs(market.yesPrice - (1 - market.noPrice));
    if (spread < 0.03) return null;

    const midPrice = (market.yesPrice + (1 - market.noPrice)) / 2;
    const side = market.yesPrice < midPrice ? 'yes' : 'no';
    const price = side === 'yes' ? market.yesPrice : market.noPrice;

    return {
      marketId: market.id,
      question: market.question,
      tokenId: side === 'yes' ? market.yesTokenId : market.noTokenId,
      side,
      price: price + 0.01,
      edge: spread / 2,
      liquidity: market.liquidity,
      volume24h: market.volume24h,
      negRisk: market.negRisk,
    };
  }

  // ---- Execute a trade via the SDK ----
  async executeTrade(opportunity) {
    const { tokenId, side, price, question, edge, negRisk } = opportunity;
    const amount = config.tradeAmountUsdc;
    const size = amount / price;

    console.log(`[TRADE] ${side.toUpperCase()} on "${question.substring(0, 60)}..." @ ${price.toFixed(3)} | edge: ${(edge * 100).toFixed(1)}% | $${amount}`);

    try {
      const result = await api.placeBuyOrder({
        tokenId,
        price: parseFloat(price.toFixed(2)),
        size: parseFloat(size.toFixed(2)),
        tickSize: '0.01',
        negRisk: negRisk || false,
      });

      this.stats.ordersPlaced++;

      // Track position
      this.positions.set(tokenId, {
        marketId: opportunity.marketId,
        question,
        side,
        size,
        avgPrice: price,
        entryTime: new Date().toISOString(),
        edge,
        negRisk,
      });

      this.totalInvested += amount;

      const trade = {
        time: new Date().toISOString(),
        question: question.substring(0, 80),
        side,
        price,
        size: size.toFixed(2),
        amount,
        edge: (edge * 100).toFixed(1) + '%',
        orderId: result.orderID || result.id || 'placed',
        status: 'filled',
      };

      this.tradeLog.unshift(trade);
      if (this.tradeLog.length > 100) this.tradeLog.pop();
      this.stats.tradesPlaced++;

      this.persist();
      console.log(`[TRADE] Order result: ${JSON.stringify(result)}`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[TRADE] Failed: ${err.message}`);

      this.tradeLog.unshift({
        time: new Date().toISOString(),
        question: question.substring(0, 80),
        side,
        price,
        size: size.toFixed(2),
        amount,
        edge: (edge * 100).toFixed(1) + '%',
        status: 'error',
        error: err.message,
      });
    }
  }

  // ---- Check and close profitable positions ----
  async rebalance() {
    console.log(`[REBALANCE] Checking ${this.positions.size} positions...`);

    let totalUnrealized = 0;

    const toRemove = [];

    for (const [tokenId, pos] of this.positions.entries()) {
      try {
        let midpoint;
        try {
          midpoint = await api.getMidpoint(tokenId);
        } catch (err) {
          console.log(`[REBALANCE] Can't get price for "${(pos.question || '').substring(0, 40)}..." — removing (${err.message})`);
          toRemove.push(tokenId);
          continue;
        }
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);

        if (currentPrice <= 0) continue;

        const profit = (currentPrice - pos.avgPrice) * pos.size;
        const profitPct = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;

        // Track unrealized P&L
        pos.currentPrice = currentPrice;
        pos.unrealizedPnl = profit;
        pos.unrealizedPct = profitPct;
        totalUnrealized += profit;

        console.log(`[REBALANCE] "${pos.question.substring(0, 40)}..." | entry: ${pos.avgPrice.toFixed(3)} | now: ${currentPrice.toFixed(3)} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${profitPct.toFixed(1)}%)`);

        // Take profit at +15% or cut loss at -20%
        if (profitPct >= 15 || profitPct <= -20) {
          const action = profitPct >= 15 ? 'TAKE PROFIT' : 'STOP LOSS';
          console.log(`[REBALANCE] ${action}: Selling ${pos.side} position`);

          try {
            // Check actual balance before selling
            const balance = await api.getBalanceAllowance(tokenId);
            const actualShares = balance ? parseFloat(balance.balance || 0) / 1e6 : 0;
            if (actualShares < 0.01) {
              console.log(`[REBALANCE] No shares held for this position (balance: ${actualShares}), removing from tracking`);
              this.positions.delete(tokenId);
              continue;
            }
            const sellSize = Math.min(pos.size, actualShares);

            await api.placeSellOrder({
              tokenId,
              price: parseFloat(currentPrice.toFixed(2)),
              size: parseFloat(sellSize.toFixed(2)),
              tickSize: '0.01',
              negRisk: pos.negRisk || false,
            });

            this.pnl += profit;
            this.totalInvested -= pos.avgPrice * pos.size;
            this.positions.delete(tokenId);

            this.tradeLog.unshift({
              time: new Date().toISOString(),
              question: pos.question.substring(0, 80),
              side: `SELL ${pos.side}`,
              price: currentPrice,
              size: pos.size.toFixed(2),
              amount: (currentPrice * pos.size).toFixed(2),
              edge: action,
              status: 'filled',
              pnl: `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`,
            });

            this.stats.tradesPlaced++;
          } catch (err) {
            console.error(`[REBALANCE] Sell failed: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`[REBALANCE] Error checking ${tokenId}: ${err.message}`);
      }
    }

    // Remove invalid/resolved positions
    for (const id of toRemove) {
      this.positions.delete(id);
    }
    if (toRemove.length > 0) {
      console.log(`[REBALANCE] Removed ${toRemove.length} invalid positions`);
    }

    this.unrealizedPnl = totalUnrealized;
    this.persist();
  }

  // ---- Get current state for dashboard ----
  getState() {
    const positionsArray = [];
    for (const [tokenId, pos] of this.positions.entries()) {
      positionsArray.push({ tokenId, ...pos });
    }

    return {
      stats: this.stats,
      positions: positionsArray,
      tradeLog: this.tradeLog.slice(0, 50),
      pnl: this.pnl,
      unrealizedPnl: this.unrealizedPnl,
      totalInvested: this.totalInvested,
      config: {
        strategy: config.strategy,
        tradeAmount: config.tradeAmountUsdc,
        maxPositions: config.maxOpenPositions,
        maxPositionSize: config.maxPositionUsdc,
        minEdge: config.minEdge,
      },
    };
  }
}

module.exports = new Strategy();
