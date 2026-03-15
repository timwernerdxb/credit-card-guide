const api = require('./api');
const config = require('./config');

// ============================================
// Trading Strategy Engine
//
// Strategies:
//   "value"  — Buy outcomes priced far from estimated fair value
//              using volume-weighted signals and mean reversion
//   "spread" — Market-make by placing bids/asks around midpoint
// ============================================

class Strategy {
  constructor() {
    this.positions = new Map();  // tokenId -> { side, size, avgPrice, marketQuestion }
    this.tradeLog = [];
    this.pnl = 0;
    this.totalInvested = 0;
    this.stats = {
      scans: 0,
      tradesPlaced: 0,
      ordersPlaced: 0,
      errors: 0,
      lastScan: null,
      startedAt: new Date().toISOString(),
    };
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
          // Skip individual market errors
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
    if (yesPrice <= 0.02 || yesPrice >= 0.98) return null; // Skip near-resolved markets

    return {
      id: market.id,
      conditionId: market.conditionId,
      question: market.question,
      category: market.category,
      yesTokenId: market.clobTokenIds[0],
      noTokenId: market.clobTokenIds[1],
      yesPrice,
      noPrice,
      volume24h: parseFloat(market.volume24hr || 0),
      volumeTotal: parseFloat(market.volume || 0),
      liquidity: parseFloat(market.liquidity || 0),
      endDate: market.endDate,
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

    // Heuristic: high-volume markets with extreme prices tend to revert
    // Buy "Yes" when price is low (undervalued) with high volume
    // Buy "No" when "Yes" price is high (overvalued)

    const yesPrice = market.yesPrice;
    const noPrice = market.noPrice;

    // Volume ratio: higher ratio = more conviction in current price
    const volumeRatio = market.volume24h / Math.max(market.volumeTotal, 1);

    // Look for value in the 0.10–0.45 and 0.55–0.90 ranges
    // These are markets where there's a clear lean but still uncertainty
    let side = null;
    let targetPrice = null;
    let edge = 0;

    // Strategy: buy the cheaper side when it's not too extreme
    // The idea: in liquid, active markets, prices near 0.15-0.40 often
    // offer value because the crowd overweights the favorite
    if (yesPrice >= 0.10 && yesPrice <= 0.40 && market.volume24h > 20000) {
      side = 'yes';
      targetPrice = yesPrice;
      // Edge estimate: how much upside vs. downside
      edge = (1 / yesPrice - 1) * 0.1; // rough expected edge
    } else if (noPrice >= 0.10 && noPrice <= 0.40 && market.volume24h > 20000) {
      side = 'no';
      targetPrice = noPrice;
      edge = (1 / noPrice - 1) * 0.1;
    }

    // Also look for mean reversion: if yes is 0.55-0.75, the "no" side
    // at 0.25-0.45 might be underpriced
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
      edge: edge,
      liquidity: market.liquidity,
      volume24h: market.volume24h,
    };
  }

  // ---- Spread strategy: market-make around midpoint ----
  evaluateSpread(market) {
    if (market.liquidity < 50000) return null;
    if (market.volume24h < 10000) return null;

    // Place limit orders slightly better than current best
    const spread = Math.abs(market.yesPrice - (1 - market.noPrice));
    if (spread < 0.03) return null; // spread too tight, no edge

    const midPrice = (market.yesPrice + (1 - market.noPrice)) / 2;

    // Buy the side where we can get a better price
    const side = market.yesPrice < midPrice ? 'yes' : 'no';
    const price = side === 'yes' ? market.yesPrice : market.noPrice;

    return {
      marketId: market.id,
      question: market.question,
      tokenId: side === 'yes' ? market.yesTokenId : market.noTokenId,
      side,
      price: price + 0.01, // improve by 1 cent
      edge: spread / 2,
      liquidity: market.liquidity,
      volume24h: market.volume24h,
    };
  }

  // ---- Execute a trade ----
  async executeTrade(opportunity) {
    const { tokenId, side, price, question, edge } = opportunity;
    const amount = config.tradeAmountUsdc;
    const size = amount / price;

    console.log(`[TRADE] ${side.toUpperCase()} on "${question.substring(0, 60)}..." @ ${price.toFixed(3)} | edge: ${(edge * 100).toFixed(1)}% | $${amount}`);

    try {
      const orderType = config.strategy === 'spread' ? 'GTC' : 'FOK';

      const result = await api.placeOrder({
        tokenId,
        price: parseFloat(price.toFixed(2)),
        size: parseFloat(size.toFixed(2)),
        side: 'BUY',
        type: orderType,
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
        orderId: result.orderID || result.id || 'unknown',
        status: 'filled',
      };

      this.tradeLog.unshift(trade);
      if (this.tradeLog.length > 100) this.tradeLog.pop();
      this.stats.tradesPlaced++;

      console.log(`[TRADE] Order placed: ${result.orderID || JSON.stringify(result)}`);
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

    for (const [tokenId, pos] of this.positions.entries()) {
      try {
        const midpoint = await api.getMidpoint(tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint.price || 0);

        if (currentPrice <= 0) continue;

        const profit = (currentPrice - pos.avgPrice) * pos.size;
        const profitPct = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;

        console.log(`[REBALANCE] "${pos.question.substring(0, 40)}..." | entry: ${pos.avgPrice.toFixed(3)} | now: ${currentPrice.toFixed(3)} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${profitPct.toFixed(1)}%)`);

        // Take profit at +15% or cut loss at -20%
        if (profitPct >= 15 || profitPct <= -20) {
          const action = profitPct >= 15 ? 'TAKE PROFIT' : 'STOP LOSS';
          console.log(`[REBALANCE] ${action}: Selling ${pos.side} position`);

          try {
            await api.placeOrder({
              tokenId,
              price: parseFloat(currentPrice.toFixed(2)),
              size: parseFloat(pos.size.toFixed(2)),
              side: 'SELL',
              type: 'FOK',
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
              edge: `${action}`,
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
