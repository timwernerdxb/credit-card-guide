const express = require('express');
const path = require('path');
const config = require('./config');
const api = require('./api');
const strategy = require('./strategy');
const btcStrategy = require('./btc-strategy');
const store = require('./store');

const app = express();
app.use(express.json());

// ============================================
// Admin auth middleware
// ============================================

function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(403).json({ error: 'ADMIN_KEY not configured' });
  }

  const provided = req.headers['x-admin-key'] || req.query.key;
  if (provided !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================
// Public API — read-only
// ============================================

app.get('/api/status', (req, res) => {
  const state = strategy.getState();
  const btcState = btcStrategy.getState();
  res.json({
    ok: true,
    uptime: process.uptime(),
    ...state,
    btc: btcState,
  });
});

// ============================================
// Admin API — requires ADMIN_KEY
// ============================================

app.post('/api/scan', requireAdmin, async (req, res) => {
  try {
    await Promise.all([strategy.scan(), btcStrategy.scan()]);
    res.json({ ok: true, message: 'Scan completed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rebalance', requireAdmin, async (req, res) => {
  try {
    await Promise.all([strategy.rebalance(), btcStrategy.rebalance()]);
    res.json({ ok: true, message: 'Rebalance completed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/stop', requireAdmin, (req, res) => {
  stopTimers();
  console.log('[BOT] Trading stopped by admin');
  res.json({ ok: true, message: 'Bot stopped' });
});

app.post('/api/start', requireAdmin, (req, res) => {
  startTimers();
  console.log('[BOT] Trading resumed by admin');
  res.json({ ok: true, message: 'Bot started' });
});

// ============================================
// Routes
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});

app.get('/admin', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) {
    return res.status(401).send('Unauthorized. Use /admin?key=YOUR_ADMIN_KEY');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ============================================
// Boot
// ============================================

let scanTimer = null;
let rebalanceTimer = null;
let btcTimer = null;
let btc5mTimer = null;

function startTimers() {
  if (scanTimer) clearInterval(scanTimer);
  if (rebalanceTimer) clearInterval(rebalanceTimer);
  if (btcTimer) clearInterval(btcTimer);
  if (btc5mTimer) clearInterval(btc5mTimer);

  scanTimer = setInterval(() => strategy.scan(), config.scanInterval);
  rebalanceTimer = setInterval(() => {
    strategy.rebalance();
    btcStrategy.rebalance();
  }, config.rebalanceInterval);
  btcTimer = setInterval(() => btcStrategy.scan(), config.btcScanInterval);

  // 5-min BTC markets — scan every 60s to catch each 5-min window
  if (config.btc5mEnabled) {
    btc5mTimer = setInterval(() => btcStrategy.scan5m(), config.btc5mScanInterval);
  }
}

function stopTimers() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (rebalanceTimer) { clearInterval(rebalanceTimer); rebalanceTimer = null; }
  if (btcTimer) { clearInterval(btcTimer); btcTimer = null; }
  if (btc5mTimer) { clearInterval(btc5mTimer); btc5mTimer = null; }
}

app.listen(config.port, async () => {
  console.log('='.repeat(50));
  console.log('  POLYMARKET TRADING BOT v2.1');
  console.log('  Using official @polymarket/clob-client SDK');
  console.log('='.repeat(50));
  console.log(`  Public dashboard: http://localhost:${config.port}`);
  console.log(`  Admin dashboard:  http://localhost:${config.port}/admin?key=YOUR_ADMIN_KEY`);
  console.log(`  Strategy:   ${config.strategy}`);
  console.log(`  Trade size: $${config.tradeAmountUsdc}`);
  console.log(`  Max positions: ${config.maxOpenPositions}`);
  console.log(`  Min edge:   ${(config.minEdge * 100).toFixed(0)}%`);
  console.log(`  BTC enabled: ${config.btcEnabled}`);
  console.log(`  BTC lottery: $${config.btcLotteryAmount}/bet (max ${config.btcMaxLotteryBets} bets)`);
  console.log(`  BTC momentum: $${config.btcMomentumAmount}/trade`);
  console.log(`  BTC 5m enabled: ${config.btc5mEnabled}`);
  console.log(`  BTC 5m amount: $${config.btc5mAmount}/window`);
  console.log('='.repeat(50));

  if (!config.privateKey) {
    console.log('[BOOT] No PRIVATE_KEY set. Dashboard running in monitor-only mode.');
    return;
  }

  // Restore persisted state
  store.load();
  strategy.restore();
  btcStrategy.restore();
  store.startAutoSave();

  try {
    await api.init();
    console.log('[BOOT] Authenticated with Polymarket CLOB API');

    // Sync from Polymarket API to reconstruct P&L and find missing positions
    await strategy.syncFromAPI();

    // Initial scans
    await strategy.scan();
    await btcStrategy.scan();
    if (config.btc5mEnabled) {
      await btcStrategy.scan5m();
    }

    // Start recurring timers
    startTimers();
    console.log('[BOOT] All trading loops started (general + BTC + 5m)');
  } catch (err) {
    console.error('[BOOT] Failed to initialize:', err.message);
    console.error('[BOOT] Check your PRIVATE_KEY and FUNDER_ADDRESS env vars');
  }
});
