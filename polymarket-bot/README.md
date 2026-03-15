# Polymarket Trading Bot

Automated trading bot for Polymarket prediction markets. Deploys on Railway.

## Setup

### 1. Deploy to Railway

- Connect this repo to [Railway](https://railway.app)
- Set root directory to `polymarket-bot`

### 2. Set Environment Variables on Railway

| Variable | Description |
|---|---|
| `POLY_API_KEY` | Your Polymarket CLOB API key |
| `POLY_API_SECRET` | Your Polymarket CLOB API secret |
| `POLY_PASSPHRASE` | Your Polymarket CLOB API passphrase |
| `TRADE_AMOUNT_USDC` | Amount per trade in USDC (default: 10) |
| `MAX_POSITION_USDC` | Max size per position (default: 100) |
| `MAX_OPEN_POSITIONS` | Max simultaneous positions (default: 5) |
| `MIN_EDGE` | Minimum edge to take a trade (default: 0.05 = 5%) |
| `STRATEGY` | `value` or `spread` (default: value) |

### 3. Get API Keys

1. Go to [polymarket.com](https://polymarket.com)
2. Connect your wallet
3. Go to Settings → API Keys
4. Generate CLOB API credentials

### 4. Fund Account

Deposit USDC to your Polymarket account on Polygon network.

## Strategies

### Value (`STRATEGY=value`)
Scans for markets where one outcome is underpriced relative to volume and liquidity signals. Buys undervalued outcomes and sells at +15% profit or -20% stop loss.

### Spread (`STRATEGY=spread`)
Market-makes by placing limit orders around the midpoint in liquid markets, capturing the bid-ask spread.

## Dashboard

The bot exposes a web dashboard on the Railway-assigned port showing:
- P&L, positions, trade log
- Manual scan/rebalance/start/stop controls

## API Endpoints

- `GET /api/status` — Current bot state
- `POST /api/scan` — Trigger market scan
- `POST /api/rebalance` — Trigger position rebalance
- `POST /api/start` — Start trading loops
- `POST /api/stop` — Stop trading loops
