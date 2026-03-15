const fs = require('fs');
const path = require('path');

// ============================================
// Simple JSON file persistence
//
// Saves bot state (positions, trades, P&L) to disk
// so it survives Railway redeployments.
//
// Set DATA_DIR env var to a Railway volume mount
// (e.g. /data) for true persistence across deploys.
// Falls back to ./data in the app directory.
// ============================================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SAVE_INTERVAL = 30 * 1000; // auto-save every 30s

let state = {
  strategy: {
    positions: [],
    tradeLog: [],
    pnl: 0,
    totalInvested: 0,
    stats: null,
  },
  btc: {
    lotteryBets: [],
    momentumBets: [],
    tradeLog: [],
    pnl: 0,
    totalBet: 0,
    stats: null,
    priceHistory: [],
  },
  savedAt: null,
};

let dirty = false;
let saveTimer = null;

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[STORE] Cannot create data dir:', err.message);
  }
}

function load() {
  try {
    ensureDir();
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...state, ...loaded };
      console.log(`[STORE] Loaded state from ${STATE_FILE} (saved ${state.savedAt || 'unknown'})`);
      return true;
    }
  } catch (err) {
    console.warn('[STORE] Could not load state:', err.message);
  }
  console.log('[STORE] No saved state found, starting fresh');
  return false;
}

function save() {
  if (!dirty) return;
  try {
    ensureDir();
    state.savedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    dirty = false;
  } catch (err) {
    console.warn('[STORE] Could not save state:', err.message);
  }
}

function markDirty() {
  dirty = true;
}

function startAutoSave() {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = setInterval(save, SAVE_INTERVAL);
  console.log('[STORE] Auto-save enabled (every 30s)');
}

function stopAutoSave() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
  save(); // final save
}

function getStrategyState() {
  return state.strategy;
}

function setStrategyState(s) {
  state.strategy = s;
  markDirty();
}

function getBTCState() {
  return state.btc;
}

function setBTCState(s) {
  state.btc = s;
  markDirty();
}

module.exports = {
  load,
  save,
  markDirty,
  startAutoSave,
  stopAutoSave,
  getStrategyState,
  setStrategyState,
  getBTCState,
  setBTCState,
};
