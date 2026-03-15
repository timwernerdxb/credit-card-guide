const fetch = require('node-fetch');
const crypto = require('crypto');
const config = require('./config');

class PolymarketAPI {
  constructor() {
    this.clobBase = config.clobBaseUrl;
    this.gammaBase = config.gammaBaseUrl;
  }

  // ---- Auth headers for CLOB API ----
  getHeaders(method, path, body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path + body;
    const signature = crypto
      .createHmac('sha256', Buffer.from(config.apiSecret, 'base64'))
      .update(message)
      .digest('base64');

    return {
      'Content-Type': 'application/json',
      'POLY-API-KEY': config.apiKey,
      'POLY-TIMESTAMP': timestamp,
      'POLY-SIGNATURE': signature,
      'POLY-PASSPHRASE': config.passphrase,
    };
  }

  // ---- Generic request ----
  async clobRequest(method, path, body = null) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = this.getHeaders(method, path, bodyStr);
    const url = `${this.clobBase}${path}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? bodyStr : undefined,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CLOB ${method} ${path} failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  // ---- Public: Fetch markets from Gamma API ----
  async getMarkets({ limit = 100, offset = 0, closed = false } = {}) {
    const url = `${this.gammaBase}/markets?closed=${closed}&limit=${limit}&offset=${offset}&order=volume24hr&ascending=false`;
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
    return this.clobRequest('GET', `/book?token_id=${tokenId}`);
  }

  // ---- CLOB: Get mid price ----
  async getMidpoint(tokenId) {
    return this.clobRequest('GET', `/midpoint?token_id=${tokenId}`);
  }

  // ---- CLOB: Get spread ----
  async getSpread(tokenId) {
    return this.clobRequest('GET', `/spread?token_id=${tokenId}`);
  }

  // ---- CLOB: Place order ----
  async placeOrder({ tokenId, price, size, side = 'BUY', type = 'GTC' }) {
    return this.clobRequest('POST', '/order', {
      tokenID: tokenId,
      price: price,
      size: size,
      side: side,
      type: type,
    });
  }

  // ---- CLOB: Cancel order ----
  async cancelOrder(orderId) {
    return this.clobRequest('DELETE', `/order/${orderId}`);
  }

  // ---- CLOB: Cancel all orders ----
  async cancelAll() {
    return this.clobRequest('DELETE', '/orders');
  }

  // ---- CLOB: Get open orders ----
  async getOpenOrders() {
    return this.clobRequest('GET', '/orders?open=true');
  }

  // ---- CLOB: Get trades ----
  async getTrades() {
    return this.clobRequest('GET', '/trades');
  }

  // ---- CLOB: Get balance / positions ----
  async getBalanceAllowance() {
    return this.clobRequest('GET', '/balance-allowance');
  }
}

module.exports = new PolymarketAPI();
