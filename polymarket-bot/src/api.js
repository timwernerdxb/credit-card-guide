const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const { Wallet } = require('@ethersproject/wallet');
const fetch = require('node-fetch');
const config = require('./config');

// ---- Proxy agent setup ----
let proxyAgent = null;

function getProxyAgent() {
  if (proxyAgent) return proxyAgent;
  if (!config.proxyUrl) return undefined;

  const url = config.proxyUrl;

  if (url.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    proxyAgent = new SocksProxyAgent(url);
  } else {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(url);
  }

  console.log(`[PROXY] Using proxy: ${url.replace(/\/\/(.+?):(.+?)@/, '//$1:***@')}`);
  return proxyAgent;
}

// ---- Patched fetch that uses proxy ----
function proxiedFetch(url, options = {}) {
  const agent = getProxyAgent();
  if (agent) {
    options.agent = agent;
  }
  return fetch(url, options);
}

class PolymarketAPI {
  constructor() {
    this.client = null;
    this.signer = null;
    this.gammaBase = config.gammaBaseUrl;
  }

  // ---- Initialize authenticated CLOB client ----
  async init() {
    if (!config.privateKey) {
      throw new Error('PRIVATE_KEY env var is required');
    }

    // Monkey-patch global fetch for the CLOB client to use our proxy
    if (config.proxyUrl) {
      this._patchGlobalFetch();
    }

    this.signer = new Wallet(config.privateKey);
    console.log(`[API] Wallet address: ${this.signer.address}`);

    // Create temporary client to derive API credentials
    const tempClient = new ClobClient(config.clobHost, config.chainId, this.signer);
    const creds = await tempClient.createOrDeriveApiKey();
    console.log('[API] API credentials derived from wallet');

    // Create fully authenticated client
    this.client = new ClobClient(
      config.clobHost,
      config.chainId,
      this.signer,
      creds,
      config.signatureType,
      config.funderAddress || undefined
    );

    console.log('[API] CLOB client initialized');
    return this;
  }

  // ---- Patch axios inside the CLOB client to use proxy ----
  _patchGlobalFetch() {
    if (!config.proxyUrl) return;

    try {
      const axios = require('axios');
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const agent = new HttpsProxyAgent(config.proxyUrl);

      // Inject agent per request
      axios.interceptors.request.use((reqConfig) => {
        reqConfig.httpsAgent = agent;
        reqConfig.httpAgent = agent;
        reqConfig.proxy = false;
        return reqConfig;
      });

      // Strip agents from errors to prevent circular JSON crash
      axios.interceptors.response.use(
        (response) => response,
        (error) => {
          if (error.config) {
            delete error.config.httpsAgent;
            delete error.config.httpAgent;
          }
          return Promise.reject(error);
        }
      );

      console.log('[PROXY] Axios interceptors set for proxy');
    } catch (err) {
      console.warn('[PROXY] Could not patch axios:', err.message);
    }
  }

  // ---- Public: Fetch markets from Gamma API (no proxy needed, public API) ----
  async getMarkets({ limit = 100, closed = false } = {}) {
    const url = `${this.gammaBase}/markets?closed=${closed}&limit=${limit}&order=volume24hr&ascending=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
    return res.json();
  }

  // ---- Public: Single market (no proxy needed) ----
  async getMarket(conditionId) {
    const url = `${this.gammaBase}/markets/${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma market error: ${res.status}`);
    return res.json();
  }

  // ---- CLOB: Get order book ----
  async getOrderBook(tokenId) {
    return this.client.getOrderBook(tokenId);
  }

  // ---- CLOB: Get midpoint price ----
  async getMidpoint(tokenId) {
    return this.client.getMidpoint(tokenId);
  }

  // ---- Validate order result (CLOB client returns errors as objects, not exceptions) ----
  _validateResult(result) {
    if (!result) throw new Error('Empty response from CLOB API');
    if (result.error) throw new Error(result.error);
    if (result.status && result.status >= 400) throw new Error(result.error || `HTTP ${result.status}`);
    return result;
  }

  // ---- Clamp price to valid range (0.01 - 0.99) ----
  _clampPrice(price) {
    return Math.max(0.01, Math.min(0.99, parseFloat(price.toFixed(2))));
  }

  // ---- Round size so maker amount (price*size) has ≤ 2 decimals, taker ≤ 4 decimals ----
  _roundSize(price, size) {
    // Work in raw units to avoid floating point issues
    // USDC has 6 decimals: $1 = 1000000 raw
    // Maker amount (cost = price * size in $) must have max 2 decimals → raw must be multiple of 10000
    // Taker amount (size in shares) must have max 4 decimals → raw must be multiple of 100
    //
    // Strategy: round size DOWN so that price * size has exactly 2 decimal places
    const cost2d = Math.floor(price * size * 100) / 100; // cost with 2 decimals
    const s = Math.floor((cost2d / price) * 10000) / 10000; // size with 4 decimals
    // Verify: cost should now be clean 2 decimals
    const verifiedCost = Math.round(price * s * 100) / 100;
    // If still not clean, reduce size further
    if (Math.abs(price * s - verifiedCost) > 0.00001) {
      const s2 = Math.floor(size * 100) / 100; // fallback: 2 decimal size
      return Math.max(0.01, s2);
    }
    return Math.max(0.01, s);
  }

  // ---- CLOB: Place a buy order ----
  async placeBuyOrder({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const clampedPrice = this._clampPrice(price);
    const roundedSize = this._roundSize(clampedPrice, size);
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.BUY,
        size: roundedSize,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC
    );
    return this._validateResult(order);
  }

  // ---- CLOB: Place a sell order ----
  async placeSellOrder({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const clampedPrice = this._clampPrice(price);
    const roundedSize = this._roundSize(clampedPrice, size);
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.SELL,
        size: roundedSize,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC
    );
    return this._validateResult(order);
  }

  // ---- CLOB: Place a market (FOK) buy ----
  async placeMarketBuy({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const clampedPrice = this._clampPrice(price);
    const roundedSize = this._roundSize(clampedPrice, size);
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.BUY,
        size: roundedSize,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.FOK
    );
    return this._validateResult(order);
  }

  // ---- CLOB: Cancel order ----
  async cancelOrder(orderId) {
    return this.client.cancelOrder(orderId);
  }

  // ---- CLOB: Cancel all orders ----
  async cancelAll() {
    return this.client.cancelAll();
  }

  // ---- CLOB: Get open orders ----
  async getOpenOrders() {
    return this.client.getOpenOrders();
  }

  // ---- CLOB: Get trades ----
  async getTrades() {
    return this.client.getTrades();
  }

  // ---- CLOB: Get balances (check if we actually hold shares) ----
  async getBalanceAllowance(tokenId) {
    try {
      return await this.client.getBalanceAllowance({
        asset_type: 'CONDITIONAL',
        token_id: tokenId,
      });
    } catch (err) {
      console.warn(`[API] Balance check failed for ${tokenId.substring(0, 16)}...: ${err.message}`);
      return null;
    }
  }
}

module.exports = new PolymarketAPI();
