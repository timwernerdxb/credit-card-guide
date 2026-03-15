const express = require('express');
const path = require('path');
const config = require('./config');
const api = require('./api');
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
  stopTimers();
  console.log('[BOT] Trading stopped by user');
  res.json({ ok: true, message: 'Bot stopped' });
});

app.post('/api/start', (req, res) => {
  startTimers();
  console.log('[BOT] Trading resumed by user');
  res.json({ ok: true, message: 'Bot started' });
});

// ============================================
// Dashboard
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

function stopTimers() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (rebalanceTimer) { clearInterval(rebalanceTimer); rebalanceTimer = null; }
}

app.listen(config.port, async () => {
  console.log('='.repeat(50));
  console.log('  POLYMARKET TRADING BOT v2.0');
  console.log('  Using official @polymarket/clob-client SDK');
  console.log('='.repeat(50));
  console.log(`  Dashboard:  http://localhost:${config.port}`);
  console.log(`  Strategy:   ${config.strategy}`);
  console.log(`  Trade size: $${config.tradeAmountUsdc}`);
  console.log(`  Max positions: ${config.maxOpenPositions}`);
  console.log(`  Min edge:   ${(config.minEdge * 100).toFixed(0)}%`);
  console.log('='.repeat(50));

  if (!config.privateKey) {
    console.log('[BOOT] No PRIVATE_KEY set. Dashboard running in monitor-only mode.');
    console.log('[BOOT] Add PRIVATE_KEY env var on Railway to enable trading.');
    return;
  }

  try {
    await api.init();
    console.log('[BOOT] Authenticated with Polymarket CLOB API');

    // Initial scan
    await strategy.scan();
    // Start recurring timers
    startTimers();
    console.log('[BOOT] Trading loops started');
  } catch (err) {
    console.error('[BOOT] Failed to initialize:', err.message);
    console.error('[BOOT] Check your PRIVATE_KEY and FUNDER_ADDRESS env vars');
  }
});
