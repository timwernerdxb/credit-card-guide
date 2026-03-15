const express = require('express');
const path = require('path');
const config = require('./config');
const strategy = require('./strategy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================
// API Endpoints for Dashboard
// ============================================

app.get('/api/status', (req, res) => {
  const state = strategy.getState();
  res.json({
    ok: true,
    uptime: process.uptime(),
    ...state,
  });
});

app.post('/api/scan', async (req, res) => {
  try {
    await strategy.scan();
    res.json({ ok: true, message: 'Scan completed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rebalance', async (req, res) => {
  try {
    await strategy.rebalance();
    res.json({ ok: true, message: 'Rebalance completed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  clearInterval(scanTimer);
  clearInterval(rebalanceTimer);
  console.log('[BOT] Trading stopped by user');
  res.json({ ok: true, message: 'Bot stopped' });
});

app.post('/api/start', (req, res) => {
  startTimers();
  console.log('[BOT] Trading resumed by user');
  res.json({ ok: true, message: 'Bot started' });
});

// ============================================
// Dashboard HTML
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============================================
// Boot
// ============================================

let scanTimer = null;
let rebalanceTimer = null;

function startTimers() {
  if (scanTimer) clearInterval(scanTimer);
  if (rebalanceTimer) clearInterval(rebalanceTimer);

  scanTimer = setInterval(() => strategy.scan(), config.scanInterval);
  rebalanceTimer = setInterval(() => strategy.rebalance(), config.rebalanceInterval);
}

function validateConfig() {
  const missing = [];
  if (!config.apiKey) missing.push('POLY_API_KEY');
  if (!config.apiSecret) missing.push('POLY_API_SECRET');
  if (!config.passphrase) missing.push('POLY_PASSPHRASE');

  if (missing.length > 0) {
    console.warn(`[BOOT] Missing env vars: ${missing.join(', ')}`);
    console.warn('[BOOT] Bot will start in monitor-only mode. Set credentials to enable trading.');
    return false;
  }
  return true;
}

app.listen(config.port, async () => {
  console.log('='.repeat(50));
  console.log('  POLYMARKET TRADING BOT');
  console.log('='.repeat(50));
  console.log(`  Dashboard: http://localhost:${config.port}`);
  console.log(`  Strategy:  ${config.strategy}`);
  console.log(`  Trade size: $${config.tradeAmountUsdc}`);
  console.log(`  Max positions: ${config.maxOpenPositions}`);
  console.log(`  Min edge: ${(config.minEdge * 100).toFixed(0)}%`);
  console.log('='.repeat(50));

  const ready = validateConfig();

  if (ready) {
    console.log('[BOOT] Credentials found. Starting trading loops...');
    // Initial scan
    await strategy.scan();
    // Start recurring timers
    startTimers();
  } else {
    console.log('[BOOT] Dashboard running. Add credentials to start trading.');
  }
});
