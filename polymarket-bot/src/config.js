require('dotenv').config();

module.exports = {
  // API credentials
  apiKey: process.env.POLY_API_KEY,
  apiSecret: process.env.POLY_API_SECRET,
  passphrase: process.env.POLY_PASSPHRASE,
  privateKey: process.env.POLY_PRIVATE_KEY,

  // Endpoints
  clobBaseUrl: 'https://clob.polymarket.com',
  gammaBaseUrl: 'https://gamma-api.polymarket.com',

  // Trading parameters
  tradeAmountUsdc: parseFloat(process.env.TRADE_AMOUNT_USDC || '10'),
  maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '100'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '5'),
  minEdge: parseFloat(process.env.MIN_EDGE || '0.05'),
  strategy: process.env.STRATEGY || 'value',

  // Server
  port: parseInt(process.env.PORT || '3000'),

  // Intervals (ms)
  scanInterval: 60 * 1000,       // scan markets every 60s
  rebalanceInterval: 5 * 60 * 1000, // rebalance every 5 min
};
