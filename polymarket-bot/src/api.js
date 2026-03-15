const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const { Wallet } = require('@ethersproject/wallet');
const fetch = require('node-fetch');
const config = require('./config');

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

  // ---- Public: Fetch markets from Gamma API ----
  async getMarkets({ limit = 100, closed = false } = {}) {
    const url = `${this.gammaBase}/markets?closed=${closed}&limit=${limit}&order=volume24hr&ascending=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
    return res.json();
  }

  // ---- Public: Single market ----
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

  // ---- CLOB: Get tick size for a market token ----
  async getTickSize(tokenId) {
    try {
      const book = await this.client.getOrderBook(tokenId);
      // Default tick size
      return '0.01';
    } catch {
      return '0.01';
    }
  }

  // ---- CLOB: Get neg risk flag for market ----
  async getMarketInfo(tokenId) {
    try {
      return await this.client.getMarket(tokenId);
    } catch {
      return null;
    }
  }

  // ---- CLOB: Place a buy order ----
  async placeBuyOrder({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: parseFloat(price.toFixed(2)),
        side: Side.BUY,
        size: parseFloat(size.toFixed(2)),
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC
    );
    return order;
  }

  // ---- CLOB: Place a sell order ----
  async placeSellOrder({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: parseFloat(price.toFixed(2)),
        side: Side.SELL,
        size: parseFloat(size.toFixed(2)),
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC
    );
    return order;
  }

  // ---- CLOB: Place a market (FOK) buy ----
  async placeMarketBuy({ tokenId, price, size, tickSize = '0.01', negRisk = false }) {
    const order = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: parseFloat(price.toFixed(2)),
        side: Side.BUY,
        size: parseFloat(size.toFixed(2)),
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.FOK
    );
    return order;
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
