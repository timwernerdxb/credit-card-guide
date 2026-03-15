# Polymarket Trading Bot

Automated trading bot for Polymarket prediction markets using the official `@polymarket/clob-client` SDK. Deploys on Railway.

## Deploy to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub Repo**
2. Select `timwernerdxb/polymarket-bot`
3. Set root directory to `/` (it's the whole repo)
4. Go to **Variables** tab and add:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | Your Polygon wallet private key (the one connected to Polymarket) |
| `FUNDER_ADDRESS` | Yes | Your Polymarket deposit address |
| `SIGNATURE_TYPE` | No | `0` for MetaMask/browser wallet, `1` for email/Magic login (default: 0) |
| `TRADE_AMOUNT_USDC` | No | USDC per trade (default: 10) |
| `MAX_POSITION_USDC` | No | Max per position (default: 100) |
| `MAX_OPEN_POSITIONS` | No | Max simultaneous bets (default: 5) |
| `MIN_EDGE` | No | Minimum edge threshold (default: 0.05 = 5%) |
| `STRATEGY` | No | `value` or `spread` (default: value) |

5. Deploy

## How to Get Your Private Key

Your private key is the key for the wallet you use on Polymarket:

- **MetaMask**: Settings → Security & Privacy → Reveal Secret Recovery Phrase (or export private key for the specific account)
- **Email login (Magic)**: You may need to export from Polymarket settings

Set `SIGNATURE_TYPE=0` for MetaMask, `SIGNATURE_TYPE=1` for email login.

## How to Get Your Funder Address

This is your Polymarket profile/deposit address on Polygon. Find it in your Polymarket account settings or wallet.

## Strategies

### Value (`STRATEGY=value`)
Scans for underpriced outcomes in high-volume markets. Buys when estimated edge > MIN_EDGE. Auto-sells at +15% profit or -20% stop loss.

### Spread (`STRATEGY=spread`)
Market-makes by placing limit orders around the midpoint in liquid markets, capturing the bid-ask spread.

## Dashboard

The bot serves a live web dashboard showing:
- P&L, open positions, trade log
- Manual scan / rebalance / start / stop controls

## API

- `GET /api/status` — Bot state
- `POST /api/scan` — Trigger market scan
- `POST /api/rebalance` — Rebalance positions
- `POST /api/start` — Start trading
- `POST /api/stop` — Stop trading
