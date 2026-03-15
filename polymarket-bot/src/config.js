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

  // BTC 5-minute up/down markets
  btc5mEnabled: process.env.BTC_5M_ENABLED !== 'false', // on by default when BTC enabled
  btc5mAmount: parseFloat(process.env.BTC_5M_AMOUNT || '1'), // $1 per bet — only bets on high-payout opportunities
  btc5mMaxPrice: parseFloat(process.env.BTC_5M_MAX_PRICE || '0.35'), // only buy side priced ≤ 35¢ (2.85x+ payout)
  btc5mMinPayout: parseFloat(process.env.BTC_5M_MIN_PAYOUT || '2.50'), // minimum potential payout to place bet
  btc5mMinConfidence: parseFloat(process.env.BTC_5M_MIN_CONFIDENCE || '0.30'), // need 30%+ confidence
  btc5mScanInterval: 60 * 1000, // check every 60s to catch each 5-min window

  // Server
  port: parseInt(process.env.PORT || '3000'),

  // Intervals (ms)
  scanInterval: 60 * 1000,
  rebalanceInterval: 5 * 60 * 1000,
};
