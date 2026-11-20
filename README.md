# Entryvex

Live crypto market research in your browser: real-time prices, candle charts and the latest news, all on one screen.

> Entryvex is a research tool. It never places trades, never connects to your exchange account, and is not financial advice. You decide and you place every trade yourself.

## What it does today

- **Live watchlist:** streaming prices and 24h change for your coins, straight from Binance.US. Add any Binance.US pair with the search box.
- **Live candle chart:** 1m / 5m / 15m / 1h / 4h / 1D candles with volume, updating tick by tick.
- **Market stats:** 24h high, low and volume for the selected coin.
- **News feed:** headlines from Cointelegraph, Decrypt, CoinDesk, Bitcoin Magazine and Google News, filtered to the coin you're looking at, or all crypto.
- **Setup scanner (measured confidence):** detects 4 setups (volume breakout, trend pullback, oversold bounce, momentum turn-up) on the last closed candle, and replays every past occurrence on the last 3,000 candles of that coin + timeframe. Shows how often each one ended in profit (with a 95% range), average win/loss and average result per trade **after fees and the live bid/ask spread**, and a verdict: GO / CAUTION / UNPROVEN / NO TRADE / WAIT.
- **Trade plan** for an active setup with a positive record: buy zone, take-profit, stop-loss, result per $100 after costs and typical time to resolve, drawn on the chart.
- **Past trades on the chart:** click any setup to see where it fired before, marked W (win) or L (loss).
- **Watchlist scan:** checks every coin in your watchlist on the current timeframe and ranks them.
- **Your money:** enter your trading balance, risk per trade (default 1%) and daily loss limit (default 3%). Stored only in your browser.
- **Dollar trade card:** for an active setup, shows exactly how much to buy (rounded to Binance.US's quantity, price and minimum-order rules), what you make if the target hits and lose if the stop hits (after fees and spread), the measured average result in dollars, and step-by-step instructions for placing it on Binance.US (limit buy, then an OCO take-profit/stop sell) with copy buttons.
- **Daily loss guard:** log each trade's result; when today's losses reach your limit, Entryvex hides trade cards and tells you to stop for the day.
- **Trade calculator:** plan any trade yourself (entry, stop, target) and get the position size, dollar outcomes and break-even win rate.
- Works on desktop, tablet and phone. Your watchlist and fee setting are remembered in your browser.

## Roadmap

1. ✅ Live data: prices, charts, news
2. ✅ Setup detection and scoring: a **measured** confidence %, based on how each setup has actually played out historically
3. ✅ Trade cards and money prompt: entry, stop, target, position size, expected value after fees, go/no-go, daily loss guard
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

To print the scanner's results for any coins from the command line:

```
node tools/engine-report.mjs BTCUSDT:15m ETHUSDT:1h
```

Run the tests:

```
node --test tests/
```

## Data sources

- Binance.US public market data API (`api.binance.us`, `stream.binance.us`). Binance.US serves US users; visitors outside the US may be blocked by Binance.US.
- Public RSS feeds from the news outlets listed above. Headlines link to the original articles.
