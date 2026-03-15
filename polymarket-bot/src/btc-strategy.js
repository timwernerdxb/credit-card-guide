const api = require('./api');
const config = require('./config');

// ============================================
// BTC-Specific Trading Strategy
//
// Runs independently from the main strategy.
// Does NOT count toward MAX_OPEN_POSITIONS.
//
// Two modes:
//   1. "Lottery" — Buy extreme longshot outcomes at <2¢
//      for $1 each. If BTC hits, payout is $50-$250+.
//   2. "Momentum" — Detect BTC trends via price history
//      and bet on continuation in medium-term markets.
// ============================================

class BTCStrategy {
  constructor() {
    this.lotteryBets = [];
    this.momentumBets = [];
    this.tradeLog = [];
    this.pnl = 0;
    this.totalBet = 0;
    this.stats = {
      scans: 0,
      lotteryBetsPlaced: 0,
      momentumBetsPlaced: 0,
      errors: 0,
      lastScan: null,
    };
    this.priceHistory = []; // track BTC price for momentum
  }

  // ---- Main scan: find BTC markets and trade ----
  async scan() {
    if (!config.btcEnabled) return;

    this.stats.scans++;
    this.stats.lastScan = new Date().toISOString();
    console.log(`[BTC SCAN #${this.stats.scans}] Scanning Bitcoin markets...`);

    try {
      const markets = await api.getMarkets({ limit: 100 });
      const btcMarkets = markets.filter(m =>
        m.active && !m.closed &&
        m.clobTokenIds && m.clobTokenIds.length >= 2 &&
        this.isBTCMarket(m.question)
      );

      console.log(`[BTC SCAN] Found ${btcMarkets.length} BTC markets`);

      // Track current BTC price sentiment from markets
      this.updatePriceSentiment(btcMarkets);

      // Run both strategies
      await this.runLottery(btcMarkets);
      await this.runMomentum(btcMarkets);

    } catch (err) {
      this.stats.errors++;
      console.error('[BTC SCAN] Error:', err.message);
    }
  }

  // ---- Check if market is BTC-related ----
  isBTCMarket(question) {
    const q = question.toLowerCase();
    return (
      q.includes('bitcoin') || q.includes('btc') ||
      q.includes('bitcoin price') || q.includes('btc price')
    );
  }

  // ---- Parse a BTC market ----
  parseMarket(market) {
    let prices;
    try {
      prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
    } catch { return null; }

    if (!prices || prices.length < 2) return null;

    const yesPrice = parseFloat(prices[0]);
    const noPrice = parseFloat(prices[1]);
    if (isNaN(yesPrice) || isNaN(noPrice)) return null;

    const tokenIds = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds;

    return {
      id: market.id,
      question: market.question,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      yesPrice,
      noPrice,
      volume24h: parseFloat(market.volume24hr || 0),
      liquidity: parseFloat(market.liquidity || 0),
      endDate: market.endDate,
      negRisk: market.negRisk || false,
    };
  }

  // ============================================
  // LOTTERY STRATEGY
  // Buy extreme longshots at <2¢ with dynamic sizing
  // BTC_LOTTERY_AMOUNT is the MAX per bet — actual
  // amount is scaled by price & liquidity:
  //   < 0.5¢  →  25-40% of max (extreme longshot)
  //   0.5-1¢  →  40-65% of max
  //   1-1.5¢  →  65-85% of max
  //   1.5-2¢  →  85-100% of max (higher probability)
  // Minimum bet is always $0.50
  // ============================================

  calculateLotteryBetSize(price, liquidity, maxBet) {
    // Base: scale linearly with price (cheaper = riskier = less)
    const maxPrice = config.btcLotteryMaxPrice;
    let ratio = price / maxPrice; // 0.0 to 1.0

    // Apply tiers
    if (price < 0.005) {
      ratio = 0.25 + (ratio * 0.15); // 25-40%
    } else if (price < 0.01) {
      ratio = 0.40 + (ratio * 0.25); // 40-65%
    } else if (price < 0.015) {
      ratio = 0.65 + (ratio * 0.20); // 65-85%
    } else {
      ratio = 0.85 + (ratio * 0.15); // 85-100%
    }

    // Boost slightly for high-liquidity markets (more reliable pricing)
    if (liquidity > 50000) ratio = Math.min(1.0, ratio * 1.1);

    // Reduce for very low liquidity (harder to exit)
    if (liquidity < 5000) ratio *= 0.7;

    const amount = Math.max(0.50, Math.min(maxBet, maxBet * ratio));
    return parseFloat(amount.toFixed(2));
  }

  async runLottery(btcMarkets) {
    if (this.lotteryBets.length >= config.btcMaxLotteryBets) {
      console.log(`[BTC LOTTERY] At max bets (${config.btcMaxLotteryBets}), skipping`);
      return;
    }

    const maxPrice = config.btcLotteryMaxPrice;
    const maxBet = config.btcLotteryAmount;
    const opportunities = [];

    for (const market of btcMarkets) {
      const parsed = this.parseMarket(market);
      if (!parsed) continue;

      // Skip low-liquidity markets
      if (parsed.liquidity < 1000) continue;

      // Look for extreme longshot outcomes priced at 1¢–maxPrice (default 2¢)
      // API minimum price is 0.01 (1¢), skip anything below
      if (parsed.yesPrice >= 0.01 && parsed.yesPrice <= maxPrice) {
        const betAmount = this.calculateLotteryBetSize(parsed.yesPrice, parsed.liquidity, maxBet);
        opportunities.push({
          ...parsed,
          side: 'yes',
          price: parsed.yesPrice,
          tokenId: parsed.yesTokenId,
          betAmount,
          potentialPayout: betAmount / parsed.yesPrice,
        });
      }

      if (parsed.noPrice >= 0.01 && parsed.noPrice <= maxPrice) {
        const betAmount = this.calculateLotteryBetSize(parsed.noPrice, parsed.liquidity, maxBet);
        opportunities.push({
          ...parsed,
          side: 'no',
          price: parsed.noPrice,
          tokenId: parsed.noTokenId,
          betAmount,
          potentialPayout: betAmount / parsed.noPrice,
        });
      }
    }

    // Sort by highest potential payout
    opportunities.sort((a, b) => b.potentialPayout - a.potentialPayout);

    for (const opp of opportunities) {
      if (this.lotteryBets.length >= config.btcMaxLotteryBets) break;

      // Don't double up
      if (this.lotteryBets.some(b => b.tokenId === opp.tokenId)) continue;

      const betAmount = opp.betAmount;
      const shares = betAmount / opp.price;
      const payout = shares; // each share pays $1 if correct

      console.log(`[BTC LOTTERY] ${opp.side.toUpperCase()} on "${opp.question.substring(0, 60)}..." @ ${(opp.price * 100).toFixed(1)}¢ | $${betAmount} (max $${maxBet}) -> potential $${payout.toFixed(2)} payout`);

      try {
        const result = await api.placeBuyOrder({
          tokenId: opp.tokenId,
          price: parseFloat(opp.price.toFixed(2)),
          size: parseFloat(shares.toFixed(2)),
          tickSize: '0.01',
          negRisk: opp.negRisk,
        });

        this.lotteryBets.push({
          tokenId: opp.tokenId,
          question: opp.question,
          side: opp.side,
          price: opp.price,
          shares,
          amount: betAmount,
          potentialPayout: payout,
          time: new Date().toISOString(),
        });

        this.totalBet += betAmount;
        this.stats.lotteryBetsPlaced++;

        this.tradeLog.unshift({
          time: new Date().toISOString(),
          type: 'LOTTERY',
          question: opp.question.substring(0, 80),
          side: opp.side,
          price: opp.price,
          shares: shares.toFixed(2),
          amount: betAmount,
          potentialPayout: `$${payout.toFixed(2)}`,
          status: 'placed',
        });

        console.log(`[BTC LOTTERY] Placed! ${shares.toFixed(0)} shares, potential $${payout.toFixed(2)}`);
      } catch (err) {
        this.stats.errors++;
        console.error(`[BTC LOTTERY] Failed: ${err.message}`);
        this.tradeLog.unshift({
          time: new Date().toISOString(),
          type: 'LOTTERY',
          question: opp.question.substring(0, 80),
          side: opp.side,
          price: opp.price,
          amount: betAmount,
          status: 'error',
          error: err.message,
        });
      }
    }
  }

  // ============================================
  // MOMENTUM STRATEGY
  // Track BTC price sentiment across markets.
  // When most markets lean bullish → buy YES on
  // "BTC above X" markets at reasonable prices.
  // When bearish → buy NO.
  //
  // BTC_MOMENTUM_AMOUNT is the MAX. Actual size is
  // scaled by trend strength, liquidity, and price:
  //   Weak trend   → 30-50% of max
  //   Medium trend → 50-75% of max
  //   Strong trend → 75-100% of max
  // Higher liquidity and mid-range prices get a boost.
  // Minimum bet is always $1.
  // ============================================

  calculateMomentumBetSize(trendStrength, price, liquidity, maxBet) {
    // trendStrength: absolute value of sentiment change (0.03 = weak, 0.10+ = strong)
    let ratio;

    if (trendStrength < 0.05) {
      ratio = 0.30 + (trendStrength / 0.05) * 0.20; // 30-50%
    } else if (trendStrength < 0.08) {
      ratio = 0.50 + ((trendStrength - 0.05) / 0.03) * 0.25; // 50-75%
    } else {
      ratio = 0.75 + Math.min(0.25, (trendStrength - 0.08) / 0.05 * 0.25); // 75-100%
    }

    // Price sweet spot: best value in 0.25-0.45 range
    if (price >= 0.25 && price <= 0.45) {
      ratio = Math.min(1.0, ratio * 1.15); // 15% boost
    } else if (price < 0.20 || price > 0.55) {
      ratio *= 0.8; // reduce for extreme prices
    }

    // Liquidity boost
    if (liquidity > 100000) {
      ratio = Math.min(1.0, ratio * 1.1);
    } else if (liquidity < 10000) {
      ratio *= 0.7;
    }

    const amount = Math.max(1.0, Math.min(maxBet, maxBet * ratio));
    return parseFloat(amount.toFixed(2));
  }

  updatePriceSentiment(btcMarkets) {
    // Extract implied BTC direction from market prices
    let bullishScore = 0;
    let bearishScore = 0;
    let count = 0;

    for (const market of btcMarkets) {
      const parsed = this.parseMarket(market);
      if (!parsed) continue;

      const q = parsed.question.toLowerCase();

      // Markets like "BTC above $X" — high yes price = bullish
      if (q.includes('above') || q.includes('over') || q.includes('reach') || q.includes('hit')) {
        bullishScore += parsed.yesPrice;
        bearishScore += parsed.noPrice;
        count++;
      }

      // Markets like "BTC below $X" — high yes price = bearish
      if (q.includes('below') || q.includes('under') || q.includes('drop') || q.includes('fall')) {
        bearishScore += parsed.yesPrice;
        bullishScore += parsed.noPrice;
        count++;
      }
    }

    if (count === 0) return;

    const sentiment = bullishScore / (bullishScore + bearishScore);
    this.priceHistory.push({
      time: Date.now(),
      sentiment,
      bullish: bullishScore / count,
      bearish: bearishScore / count,
    });

    // Keep last 60 readings (5 hours at 5-min intervals)
    if (this.priceHistory.length > 60) this.priceHistory.shift();

    console.log(`[BTC MOMENTUM] Sentiment: ${(sentiment * 100).toFixed(1)}% bullish (${count} markets)`);
  }

  async runMomentum(btcMarkets) {
    // Need at least 3 readings to detect a trend
    if (this.priceHistory.length < 3) {
      console.log('[BTC MOMENTUM] Building price history, need more data...');
      return;
    }

    const recent = this.priceHistory.slice(-3);
    const trend = recent[2].sentiment - recent[0].sentiment;
    const currentSentiment = recent[2].sentiment;

    console.log(`[BTC MOMENTUM] Trend: ${trend > 0 ? '+' : ''}${(trend * 100).toFixed(1)}% | Current: ${(currentSentiment * 100).toFixed(1)}% bullish`);

    // Strong trend detection
    const isBullish = trend > 0.03 && currentSentiment > 0.55;
    const isBearish = trend < -0.03 && currentSentiment < 0.45;

    if (!isBullish && !isBearish) {
      console.log('[BTC MOMENTUM] No strong trend, waiting...');
      return;
    }

    const direction = isBullish ? 'bullish' : 'bearish';
    const trendStrength = Math.abs(trend);
    const maxBet = config.btcMomentumAmount;
    console.log(`[BTC MOMENTUM] Detected ${direction} trend (strength: ${(trendStrength * 100).toFixed(1)}%), looking for trades...`);

    for (const market of btcMarkets) {
      const parsed = this.parseMarket(market);
      if (!parsed) continue;
      if (parsed.liquidity < 5000) continue;

      // Already in this market?
      if (this.momentumBets.some(b => b.marketId === parsed.id)) continue;

      const q = parsed.question.toLowerCase();
      let side = null;
      let price = null;
      let tokenId = null;

      if (q.includes('above') || q.includes('over') || q.includes('reach') || q.includes('hit')) {
        if (isBullish && parsed.yesPrice >= 0.15 && parsed.yesPrice <= 0.60) {
          side = 'yes';
          price = parsed.yesPrice;
          tokenId = parsed.yesTokenId;
        } else if (isBearish && parsed.noPrice >= 0.15 && parsed.noPrice <= 0.60) {
          side = 'no';
          price = parsed.noPrice;
          tokenId = parsed.noTokenId;
        }
      }

      if (q.includes('below') || q.includes('under') || q.includes('drop') || q.includes('fall')) {
        if (isBearish && parsed.yesPrice >= 0.15 && parsed.yesPrice <= 0.60) {
          side = 'yes';
          price = parsed.yesPrice;
          tokenId = parsed.yesTokenId;
        } else if (isBullish && parsed.noPrice >= 0.15 && parsed.noPrice <= 0.60) {
          side = 'no';
          price = parsed.noPrice;
          tokenId = parsed.noTokenId;
        }
      }

      if (!side) continue;

      const betAmount = this.calculateMomentumBetSize(trendStrength, price, parsed.liquidity, maxBet);
      const shares = betAmount / price;

      console.log(`[BTC MOMENTUM] ${direction.toUpperCase()} → ${side.toUpperCase()} on "${parsed.question.substring(0, 60)}..." @ ${(price * 100).toFixed(1)}¢ | $${betAmount} (max $${maxBet})`);

      try {
        await api.placeBuyOrder({
          tokenId,
          price: parseFloat(price.toFixed(2)),
          size: parseFloat(shares.toFixed(2)),
          tickSize: '0.01',
          negRisk: parsed.negRisk,
        });

        this.momentumBets.push({
          marketId: parsed.id,
          tokenId,
          question: parsed.question,
          side,
          price,
          shares,
          amount: betAmount,
          direction,
          time: new Date().toISOString(),
        });

        this.totalBet += betAmount;
        this.stats.momentumBetsPlaced++;

        this.tradeLog.unshift({
          time: new Date().toISOString(),
          type: 'MOMENTUM',
          question: parsed.question.substring(0, 80),
          side,
          price,
          shares: shares.toFixed(2),
          amount: betAmount,
          direction,
          status: 'placed',
        });

        console.log(`[BTC MOMENTUM] Order placed!`);

        // Only take 1-2 momentum bets per scan
        if (this.momentumBets.length >= 3) break;

      } catch (err) {
        this.stats.errors++;
        console.error(`[BTC MOMENTUM] Failed: ${err.message}`);
      }
    }
  }

  // ---- Rebalance: check momentum positions for exit ----
  async rebalance() {
    console.log(`[BTC REBALANCE] Checking ${this.momentumBets.length} momentum positions...`);

    for (let i = this.momentumBets.length - 1; i >= 0; i--) {
      const pos = this.momentumBets[i];

      try {
        const midpoint = await api.getMidpoint(pos.tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);
        if (currentPrice <= 0) continue;

        const profit = (currentPrice - pos.price) * pos.shares;
        const profitPct = ((currentPrice - pos.price) / pos.price) * 100;

        console.log(`[BTC REBALANCE] "${pos.question.substring(0, 40)}..." | ${pos.price.toFixed(3)} -> ${currentPrice.toFixed(3)} | ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`);

        // Take profit at +20% or stop loss at -25%
        if (profitPct >= 20 || profitPct <= -25) {
          const action = profitPct >= 20 ? 'TAKE PROFIT' : 'STOP LOSS';

          try {
            await api.placeSellOrder({
              tokenId: pos.tokenId,
              price: parseFloat(currentPrice.toFixed(2)),
              size: parseFloat(pos.shares.toFixed(2)),
              tickSize: '0.01',
              negRisk: pos.negRisk || false,
            });

            this.pnl += profit;
            this.momentumBets.splice(i, 1);

            this.tradeLog.unshift({
              time: new Date().toISOString(),
              type: 'MOMENTUM EXIT',
              question: pos.question.substring(0, 80),
              side: `SELL ${pos.side}`,
              price: currentPrice,
              amount: (currentPrice * pos.shares).toFixed(2),
              pnl: `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`,
              status: action,
            });

            console.log(`[BTC REBALANCE] ${action}: $${profit.toFixed(2)}`);
          } catch (err) {
            console.error(`[BTC REBALANCE] Sell failed: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`[BTC REBALANCE] Error: ${err.message}`);
      }
    }
  }

  // ---- Get state for dashboard ----
  getState() {
    return {
      stats: this.stats,
      lotteryBets: this.lotteryBets,
      momentumBets: this.momentumBets,
      tradeLog: this.tradeLog.slice(0, 30),
      pnl: this.pnl,
      totalBet: this.totalBet,
      priceHistory: this.priceHistory.slice(-12),
      sentiment: this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].sentiment
        : null,
    };
  }
}

module.exports = new BTCStrategy();
