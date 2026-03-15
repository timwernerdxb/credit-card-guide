const api = require('./api');
const config = require('./config');
const store = require('./store');
const fetch = require('node-fetch');

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
    this.unrealizedPnl = 0;
    this.totalBet = 0;
    this.stats = {
      scans: 0,
      lotteryBetsPlaced: 0,
      momentumBetsPlaced: 0,
      errors: 0,
      lastScan: null,
    };
    this.priceHistory = []; // track BTC price for momentum
    this.fiveMinBets = []; // 5-minute up/down bets
    this.lastWindowTs = 0; // last 5-min window we bet on
    this.fiveMinHistory = []; // track 5-min outcomes for learning
  }

  // ---- Restore state from persistent storage ----
  restore() {
    const saved = store.getBTCState();
    if (!saved || !saved.stats) return;

    this.lotteryBets = saved.lotteryBets || [];
    this.momentumBets = saved.momentumBets || [];
    this.tradeLog = saved.tradeLog || [];
    this.pnl = saved.pnl || 0;
    this.totalBet = saved.totalBet || 0;
    this.priceHistory = saved.priceHistory || [];
    this.fiveMinBets = saved.fiveMinBets || [];
    this.lastWindowTs = saved.lastWindowTs || 0;
    this.fiveMinHistory = saved.fiveMinHistory || [];
    if (saved.stats) {
      this.stats = { ...this.stats, ...saved.stats };
    }
    console.log(`[BTC] Restored: ${this.lotteryBets.length} lottery, ${this.momentumBets.length} momentum, ${this.fiveMinBets.length} 5m bets, P&L: $${this.pnl.toFixed(2)}`);
  }

  // ---- Persist current state ----
  persist() {
    store.setBTCState({
      lotteryBets: this.lotteryBets,
      momentumBets: this.momentumBets,
      tradeLog: this.tradeLog,
      pnl: this.pnl,
      totalBet: this.totalBet,
      stats: this.stats,
      priceHistory: this.priceHistory,
      fiveMinBets: this.fiveMinBets,
      lastWindowTs: this.lastWindowTs,
      fiveMinHistory: this.fiveMinHistory,
    });
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

    this.persist();
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

        this.persist();
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

        this.persist();
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

    let totalUnrealized = 0;

    // Check momentum bets
    for (let i = this.momentumBets.length - 1; i >= 0; i--) {
      const pos = this.momentumBets[i];

      try {
        const midpoint = await api.getMidpoint(pos.tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);
        if (currentPrice <= 0) continue;

        const profit = (currentPrice - pos.price) * pos.shares;
        const profitPct = ((currentPrice - pos.price) / pos.price) * 100;

        pos.currentPrice = currentPrice;
        pos.unrealizedPnl = profit;
        pos.unrealizedPct = profitPct;
        totalUnrealized += profit;

        console.log(`[BTC REBALANCE] "${pos.question.substring(0, 40)}..." | ${pos.price.toFixed(3)} -> ${currentPrice.toFixed(3)} | ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`);

        // Take profit at +20% or stop loss at -25%
        if (profitPct >= 20 || profitPct <= -25) {
          const action = profitPct >= 20 ? 'TAKE PROFIT' : 'STOP LOSS';

          try {
            // Check actual balance before selling
            const balance = await api.getBalanceAllowance(pos.tokenId);
            const actualShares = balance ? parseFloat(balance.balance || 0) / 1e6 : 0;
            if (actualShares < 0.01) {
              console.log(`[BTC REBALANCE] No shares held, removing from tracking`);
              this.momentumBets.splice(i, 1);
              continue;
            }
            const sellSize = Math.min(pos.shares, actualShares);

            await api.placeSellOrder({
              tokenId: pos.tokenId,
              price: parseFloat(currentPrice.toFixed(2)),
              size: parseFloat(sellSize.toFixed(2)),
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

    // Check lottery bets for current value
    for (const bet of this.lotteryBets) {
      try {
        const midpoint = await api.getMidpoint(bet.tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);
        if (currentPrice <= 0) continue;

        const profit = (currentPrice - bet.price) * bet.shares;
        bet.currentPrice = currentPrice;
        bet.unrealizedPnl = profit;
        totalUnrealized += profit;
      } catch (err) {
        // silently skip
      }
    }

    // Check 5-min bet outcomes
    await this._trackResolved5mOutcomes();

    // Track unrealized on active 5-min bets
    for (const bet of this.fiveMinBets) {
      if (bet.resolved) continue;
      try {
        const midpoint = await api.getMidpoint(bet.tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);
        if (currentPrice <= 0) continue;
        const profit = (currentPrice - bet.price) * bet.shares;
        bet.currentPrice = currentPrice;
        bet.unrealizedPnl = profit;
        totalUnrealized += profit;
      } catch { /* skip */ }
    }

    this.unrealizedPnl = totalUnrealized;
    this.persist();
  }

  // ============================================
  // 5-MINUTE BTC UP/DOWN MARKET STRATEGY
  //
  // Polymarket has 5-min BTC prediction markets:
  //   "Will Bitcoin go up in the next 5 minutes?"
  // New market every 5 minutes at timestamp divisible by 300.
  //
  // Discovery: slug = btc-updown-5m-{windowTs}
  // API: gamma-api.polymarket.com/events?slug=btc-updown-5m-{windowTs}
  //
  // Strategy: Use recent 5-min outcomes + momentum sentiment
  // to predict Up vs Down in the next window.
  // ============================================

  // ---- Get current and next 5-min window timestamps ----
  _get5mWindows() {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(now / 300) * 300;
    const nextWindow = currentWindow + 300;
    const secsLeft = nextWindow - now;
    return { currentWindow, nextWindow, secsLeft };
  }

  // ---- Fetch 5-min market from Gamma API ----
  async _fetch5mMarket(windowTs) {
    const slug = `btc-updown-5m-${windowTs}`;
    const url = `${config.gammaBaseUrl}/events?slug=${slug}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;

      const events = await res.json();
      if (!events || events.length === 0) return null;

      const event = events[0];
      if (!event.markets || event.markets.length === 0) return null;

      const market = event.markets[0];
      if (!market.clobTokenIds || market.closed) return null;

      const tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices) : market.outcomePrices;

      if (!tokenIds || tokenIds.length < 2 || !prices || prices.length < 2) return null;

      return {
        slug,
        windowTs,
        question: market.question || `BTC 5m ${new Date(windowTs * 1000).toLocaleTimeString()}`,
        upTokenId: tokenIds[0],    // Yes = Up
        downTokenId: tokenIds[1],  // No = Down
        upPrice: parseFloat(prices[0]),
        downPrice: parseFloat(prices[1]),
        conditionId: market.conditionId,
        negRisk: market.negRisk || false,
      };
    } catch (err) {
      console.error(`[BTC 5M] Error fetching market ${slug}:`, err.message);
      return null;
    }
  }

  // ---- Analyze momentum to decide Up vs Down ----
  _analyze5mSignal(market) {
    // Collect signals from multiple sources
    let upScore = 0;
    let downScore = 0;

    // Signal 1: Market price itself (crowd wisdom)
    // If Up is trading > 50¢, crowd expects Up
    if (market.upPrice > 0.55) {
      upScore += 1;
    } else if (market.downPrice > 0.55) {
      downScore += 1;
    }

    // Signal 2: Recent 5-min outcomes (streak detection)
    const recentOutcomes = this.fiveMinHistory.slice(-6); // last 30 min
    if (recentOutcomes.length >= 2) {
      const lastTwo = recentOutcomes.slice(-2);
      const streak = lastTwo.every(o => o.result === 'up') ? 'up'
        : lastTwo.every(o => o.result === 'down') ? 'down' : null;

      if (streak === 'up') {
        // Momentum: if 2+ up in a row, lean up (trend continuation)
        upScore += 1.5;
      } else if (streak === 'down') {
        downScore += 1.5;
      }

      // Mean reversion after 3+ streak
      const lastThree = recentOutcomes.slice(-3);
      if (lastThree.length === 3 && lastThree.every(o => o.result === 'up')) {
        // Long streak — add some mean reversion (reduce up bias)
        downScore += 0.5;
      } else if (lastThree.length === 3 && lastThree.every(o => o.result === 'down')) {
        upScore += 0.5;
      }
    }

    // Signal 3: Momentum from general BTC markets sentiment
    if (this.priceHistory.length >= 2) {
      const latest = this.priceHistory[this.priceHistory.length - 1];
      const prev = this.priceHistory[this.priceHistory.length - 2];
      const sentimentChange = latest.sentiment - prev.sentiment;

      if (sentimentChange > 0.02) {
        upScore += 1; // growing bullish sentiment
      } else if (sentimentChange < -0.02) {
        downScore += 1; // growing bearish sentiment
      }
    }

    // Signal 4: Look for value (bet the cheaper side when signals are neutral)
    if (Math.abs(upScore - downScore) < 0.5) {
      // Neutral — buy the cheaper side for better odds
      if (market.upPrice < market.downPrice) {
        upScore += 0.3;
      } else {
        downScore += 0.3;
      }
    }

    const totalScore = upScore + downScore;
    const confidence = totalScore > 0 ? Math.abs(upScore - downScore) / totalScore : 0;

    const direction = upScore >= downScore ? 'up' : 'down';

    return {
      direction,
      confidence,
      upScore,
      downScore,
      reasoning: `Up: ${upScore.toFixed(1)}, Down: ${downScore.toFixed(1)}, Confidence: ${(confidence * 100).toFixed(0)}%`,
    };
  }

  // ---- Scan and trade 5-minute markets ----
  async scan5m() {
    if (!config.btcEnabled || !config.btc5mEnabled) return;

    const { currentWindow, nextWindow, secsLeft } = this._get5mWindows();

    // Only bet if we haven't already bet on this window AND
    // there's enough time left (at least 60s) to get the order in
    if (this.lastWindowTs >= currentWindow) {
      return; // already bet on this window
    }

    // Try current window first (if still open), then next if current is about to end
    let targetTs = currentWindow;
    if (secsLeft < 60) {
      // Current window closing soon, try next window
      targetTs = nextWindow;
      if (this.lastWindowTs >= nextWindow) return;
    }

    console.log(`[BTC 5M] Scanning window ${new Date(targetTs * 1000).toLocaleTimeString()} (${secsLeft}s left in current)...`);

    const market = await this._fetch5mMarket(targetTs);
    if (!market) {
      // Try next window if current isn't available yet
      if (targetTs === currentWindow) {
        const nextMarket = await this._fetch5mMarket(nextWindow);
        if (nextMarket && this.lastWindowTs < nextWindow) {
          await this._trade5m(nextMarket);
        } else {
          console.log('[BTC 5M] No 5-min market found for current or next window');
        }
      }
      return;
    }

    await this._trade5m(market);
  }

  // ---- Place a bet on a 5-minute market ----
  async _trade5m(market) {
    const signal = this._analyze5mSignal(market);

    console.log(`[BTC 5M] "${market.question}" | Up: ${(market.upPrice * 100).toFixed(1)}¢ Down: ${(market.downPrice * 100).toFixed(1)}¢`);
    console.log(`[BTC 5M] Signal: ${signal.direction.toUpperCase()} | ${signal.reasoning}`);

    // Only bet if we have some confidence
    if (signal.confidence < 0.1) {
      console.log('[BTC 5M] Low confidence, skipping this window');
      this.lastWindowTs = market.windowTs;
      return;
    }

    const betAmount = config.btc5mAmount;
    const isUp = signal.direction === 'up';
    const tokenId = isUp ? market.upTokenId : market.downTokenId;
    const price = isUp ? market.upPrice : market.downPrice;

    // Don't buy at extreme prices
    if (price > 0.85 || price < 0.05) {
      console.log(`[BTC 5M] Price ${(price * 100).toFixed(1)}¢ too extreme, skipping`);
      this.lastWindowTs = market.windowTs;
      return;
    }

    const shares = betAmount / price;
    const potentialPayout = shares; // $1 per share if correct

    console.log(`[BTC 5M] Betting $${betAmount} on ${signal.direction.toUpperCase()} @ ${(price * 100).toFixed(1)}¢ → potential $${potentialPayout.toFixed(2)}`);

    try {
      await api.placeBuyOrder({
        tokenId,
        price: parseFloat(price.toFixed(2)),
        size: parseFloat(shares.toFixed(2)),
        tickSize: '0.01',
        negRisk: market.negRisk,
      });

      this.lastWindowTs = market.windowTs;

      this.fiveMinBets.push({
        windowTs: market.windowTs,
        tokenId,
        question: market.question,
        direction: signal.direction,
        price,
        shares,
        amount: betAmount,
        potentialPayout,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
        time: new Date().toISOString(),
      });

      this.totalBet += betAmount;
      this.stats.lotteryBetsPlaced++; // count 5m bets in lottery stats

      this.tradeLog.unshift({
        time: new Date().toISOString(),
        type: '5M-BTC',
        question: market.question.substring(0, 80),
        side: signal.direction,
        price,
        shares: shares.toFixed(2),
        amount: betAmount,
        potentialPayout: `$${potentialPayout.toFixed(2)}`,
        confidence: `${(signal.confidence * 100).toFixed(0)}%`,
        status: 'placed',
      });

      // Keep trade log manageable
      if (this.tradeLog.length > 100) this.tradeLog.length = 100;

      this.persist();
      console.log(`[BTC 5M] Order placed! ${shares.toFixed(2)} shares`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[BTC 5M] Order failed: ${err.message}`);

      this.tradeLog.unshift({
        time: new Date().toISOString(),
        type: '5M-BTC',
        question: market.question.substring(0, 80),
        side: signal.direction,
        price,
        amount: betAmount,
        status: 'error',
        error: err.message,
      });
    }
  }

  // ---- Track resolved 5-min market outcomes for learning ----
  async _trackResolved5mOutcomes() {
    // Check recent 5-min bets to see if their markets resolved
    for (let i = this.fiveMinBets.length - 1; i >= 0; i--) {
      const bet = this.fiveMinBets[i];

      // Skip if already resolved or too recent (< 6 min old)
      if (bet.resolved) continue;
      const ageMs = Date.now() - new Date(bet.time).getTime();
      if (ageMs < 6 * 60 * 1000) continue;

      try {
        const midpoint = await api.getMidpoint(bet.tokenId);
        const currentPrice = parseFloat(midpoint.mid || midpoint || 0);

        // 5-min markets resolve to ~1.0 (won) or ~0.0 (lost)
        if (currentPrice > 0.90) {
          // Won!
          const pnl = (1.0 - bet.price) * bet.shares;
          bet.resolved = true;
          bet.won = true;
          bet.pnl = pnl;
          this.pnl += pnl;

          this.fiveMinHistory.push({
            windowTs: bet.windowTs,
            direction: bet.direction,
            result: bet.direction, // our bet direction was correct
            time: bet.time,
          });

          console.log(`[BTC 5M] WON! ${bet.direction.toUpperCase()} bet → +$${pnl.toFixed(2)}`);
        } else if (currentPrice < 0.10) {
          // Lost
          const pnl = -bet.amount;
          bet.resolved = true;
          bet.won = false;
          bet.pnl = pnl;
          this.pnl += pnl;

          // Record the actual result (opposite of our bet)
          this.fiveMinHistory.push({
            windowTs: bet.windowTs,
            direction: bet.direction,
            result: bet.direction === 'up' ? 'down' : 'up',
            time: bet.time,
          });

          console.log(`[BTC 5M] LOST. ${bet.direction.toUpperCase()} bet → -$${bet.amount.toFixed(2)}`);
        }
        // else: not resolved yet, check next time
      } catch {
        // skip, check next rebalance
      }
    }

    // Keep only last 50 history entries for learning
    if (this.fiveMinHistory.length > 50) {
      this.fiveMinHistory = this.fiveMinHistory.slice(-50);
    }

    // Remove resolved bets older than 1 hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.fiveMinBets = this.fiveMinBets.filter(b =>
      !b.resolved || new Date(b.time).getTime() > oneHourAgo
    );
  }

  // ---- Get state for dashboard ----
  getState() {
    return {
      stats: this.stats,
      lotteryBets: this.lotteryBets,
      momentumBets: this.momentumBets,
      fiveMinBets: this.fiveMinBets.filter(b => !b.resolved),
      fiveMinHistory: this.fiveMinHistory.slice(-12),
      tradeLog: this.tradeLog.slice(0, 50),
      pnl: this.pnl,
      unrealizedPnl: this.unrealizedPnl,
      totalBet: this.totalBet,
      priceHistory: this.priceHistory.slice(-12),
      sentiment: this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].sentiment
        : null,
    };
  }
}

module.exports = new BTCStrategy();
