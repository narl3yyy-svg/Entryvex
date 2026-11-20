# Entryvex

Live crypto market research in your browser: real-time prices, candle charts and the latest news, all on one screen.

> Entryvex is a research tool. It never places trades, never connects to your exchange account, and is not financial advice. You decide and you place every trade yourself.

## What it does today (step 1)

- **Live watchlist:** streaming prices and 24h change for your coins, straight from Binance.US. Add any Binance.US pair with the search box.
- **Live candle chart:** 1m / 5m / 15m / 1h / 4h / 1D candles with volume, updating tick by tick.
- **Market stats:** 24h high, low and volume for the selected coin.
- **News feed:** headlines from Cointelegraph, Decrypt, CoinDesk, Bitcoin Magazine and Google News, filtered to the coin you're looking at, or all crypto.
- Works on desktop, tablet and phone. Your watchlist is remembered in your browser.

## Roadmap

1. ✅ Live data: prices, charts, news
2. Setup detection and scoring: a **measured** confidence %, based on how each setup has actually played out historically
3. Trade cards and money prompt: entry, stop, target, position size, expected value after fees, go/no-go
4. News sentiment and plain-English coin/company summaries
5. Dashboard polish and alerts
6. Track record of every signal, plus a daily loss-limit "session guard"

## How it's built

| Part | Where it runs | Notes |
|---|---|---|
| `public/` | The visitor's browser | Plain HTML/CSS/JS, no build step. Market data comes directly from the Binance.US public API and WebSocket (read-only, no keys). |
| `src/worker.js` + `functions/api/news.js` | Cloudflare Worker | Fetches and merges RSS news feeds (browsers can't read them directly), cached for 3 minutes. |

## Hosting

See **[docs/SETUP.md](docs/SETUP.md)** for buying the domain and putting the site online with Cloudflare Workers. After setup, every push to `main` redeploys automatically.

## Preview locally (optional)

Requires [Node.js](https://nodejs.org) 18+. No packages to install.

```
node dev-server.mjs
```

Then open http://localhost:8788.

## Data sources

- Binance.US public market data API (`api.binance.us`, `stream.binance.us`). Binance.US serves US users; visitors outside the US may be blocked by Binance.US.
- Public RSS feeds from the news outlets listed above. Headlines link to the original articles.
