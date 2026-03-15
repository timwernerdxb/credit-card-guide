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
      const parsed = new URL(config.proxyUrl);

      // Use axios native proxy config (no agent = no circular refs)
      axios.defaults.proxy = {
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parseInt(parsed.port),
        auth: parsed.username ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        } : undefined,
      };

      console.log(`[PROXY] Axios proxy set: ${parsed.hostname}:${parsed.port}`);
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

  // ---- CLOB: Place a buy order ----
  async placeBuyOrder({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const clampedPrice = this._clampPrice(price);
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.BUY,
        size: parseFloat(Math.max(0.01, size).toFixed(2)),
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
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.SELL,
        size: parseFloat(Math.max(0.01, size).toFixed(2)),
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
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: clampedPrice,
        side: Side.BUY,
        size: parseFloat(Math.max(0.01, size).toFixed(2)),
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
}

module.exports = new PolymarketAPI();
