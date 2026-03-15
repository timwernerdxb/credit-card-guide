require('dotenv').config();

module.exports = {
  // Wallet auth
  privateKey: process.env.PRIVATE_KEY,
  funderAddress: process.env.FUNDER_ADDRESS,
  signatureType: parseInt(process.env.SIGNATURE_TYPE || '0'),

  // Proxy (HTTP or SOCKS5)
  proxyUrl: process.env.PROXY_URL || '',

  // Endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaBaseUrl: 'https://gamma-api.polymarket.com',
  chainId: 137, // Polygon

  // Trading parameters
  tradeAmountUsdc: parseFloat(process.env.TRADE_AMOUNT_USDC || '10'),
  maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '100'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '5'),
  minEdge: parseFloat(process.env.MIN_EDGE || '0.05'),
  strategy: process.env.STRATEGY || 'value',

  // BTC strategy
  btcEnabled: process.env.BTC_ENABLED !== 'false', // on by default
  btcLotteryAmount: parseFloat(process.env.BTC_LOTTERY_AMOUNT || '1'),
  btcMomentumAmount: parseFloat(process.env.BTC_MOMENTUM_AMOUNT || '5'),
  btcMaxLotteryBets: parseInt(process.env.BTC_MAX_LOTTERY_BETS || '10'),
  btcLotteryMaxPrice: parseFloat(process.env.BTC_LOTTERY_MAX_PRICE || '0.02'), // max 2¢ per share
  btcScanInterval: 5 * 60 * 1000, // check BTC markets every 5 min

  // Server
  port: parseInt(process.env.PORT || '3000'),

  // Intervals (ms)
  scanInterval: 60 * 1000,
  rebalanceInterval: 5 * 60 * 1000,
};
