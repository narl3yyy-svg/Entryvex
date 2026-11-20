# Entryvex™

### ▶ Open the app: **[entryvex.trade](https://entryvex.trade)**

Entryvex is a live crypto trading research dashboard. It watches the market for you, tells you **when a trade is (and isn't) worth taking**, backs every number with **measured history instead of guesses**, sizes the trade to your money, and tracks your results. It works in any browser, on desktop or phone. Nothing to install.

> Entryvex never places trades and never connects to your exchange account. It shows you the data and a plan; **you** decide and place the order yourself (for example on Binance.US). It is a research tool, not financial advice. Trading can lose money.

---

## Quick start

1. Go to **[entryvex.trade](https://entryvex.trade)**.
2. Pick a coin from the **watchlist** on the left (or search for one).
3. Under the chart, enter your **trading balance** and how much you're willing to lose per trade (1% is a good start).
4. Look at the **Scanner** tab. It tells you GO, CAUTION, NO TRADE or WAIT.
5. Turn on **setup alerts** with the 🔔 bell so Entryvex tells you when a good setup appears.
6. If you take a trade, click **"I took this trade"** so Entryvex tracks it in **My trades**.

---

## What's on the screen

### Chart + forecast
- Live candles straight from Binance.US, with volume and the 20/50 moving averages.
- **Forecast:** dashed lines to the right of the live candle show where price has historically landed over the next 20 candles: an 80% range (outer lines), a 50% range, and the middle. Below the chart you'll see the range in dollars, **how accurate this forecast has been** (tested on past data it wasn't built from), and the measured chance the price is higher by then.

### Scanner tab: "should I trade right now?"
- Watches 4 common setups on the coin and candle size you're viewing.
- For each one, it checks **every past time it happened** (last 3,000 candles) and what would have happened after fees: did it hit the profit target or the stop-loss first? That's the **measured confidence**, e.g. "ended in profit 21 of 38 times".
- Verdicts: **GO** proven edge · **CAUTION** slight edge · **UNPROVEN** too few examples · **NO TRADE** it loses money · **WAIT** nothing is happening right now.
- **Most of the time you'll see WAIT or NO TRADE.** That's normal: most patterns don't beat fees, and not trading is often the best move.
- **Find an edge for this coin** tests 5m, 15m, 1h and 4h candles to show where this coin has actually had an edge.
- **Scan watchlist** checks every coin at once.
- When a setup with a good record is active you get a **trade card**: exactly how much to buy, the take-profit and stop-loss, what you'd make or lose in dollars after fees, and step-by-step instructions for placing it on Binance.US.

### My trades tab
- Click **"I took this trade"** on a trade card (or add a trade by hand).
- Entryvex follows the live price and **records the result automatically** when your take-profit or stop-loss is hit. If you sell yourself, enter the sale price.
- Shows your total result, win rate and history, and powers the **daily stop**: when today's losses hit your limit, Entryvex tells you to stop for the day.

### Signal record tab: can you trust the confidence?
- Every signal Entryvex gives while it's open is saved with its verdict, then checked afterwards against real prices.
- Over time you can see whether **GO signals really win as often as the scanner said**, and what would have happened to the NO TRADE ones.

### Ask the analyst (AI)
- Ask questions in plain English: *"Is now a good time to buy ETH?"*, *"If I put $500 in, what's my risk?"*, *"What's the news saying?"*
- The analyst sees the live price, forecast, scanner results, news and your settings, and explains what the data says. It can't see the future and it can be wrong.

### Research panel (right side)
- **Report:** an AI summary of the latest news, the news mood (positive vs negative headlines), and a plain-English report card for the coin: its size, how far it is from its all-time high, recent trend, supply and what the project is.
- **News:** live headlines, each marked ▲ positive, ▼ negative or • neutral.

### Alerts 🔔
- **Setup alerts:** when a setup with a positive track record appears anywhere on your watchlist.
- **Big move alerts:** when a coin moves more than X% in N minutes.
- **Price alerts:** when a coin goes above or below a price.
- Shown on screen with a sound, and optionally as desktop notifications. Alerts work while Entryvex is open in a browser tab (a background tab is fine).

### Settings explained
| Setting | What it means |
|---|---|
| Trading balance | The money in your exchange account you're willing to trade with. |
| Max loss per trade | The most one trade may lose if its stop-loss is hit, as a % of your balance. Entryvex sizes every trade so you never lose more than this. |
| Stop for the day at | When today's losses reach this %, Entryvex tells you to stop. |
| How you'll place orders | Picks the trading fee. On Binance.US, a **limit order** (you set the price) costs 0%; a **market order** (buy instantly) costs 0.02%. Simple "Buy" buttons in apps usually charge much more. |

All settings, trades and alerts are stored **only in your own browser**.

### Keyboard shortcuts
`/` search · `1`–`6` candle size · `↑` `↓` previous/next coin · `L` center live candle · `F` forecast · `E` moving averages · `A` alerts · `?` help

---

## Good to know
- **Markets:** crypto pairs on Binance.US (spot). Binance.US only serves US users.
- **No shorting:** Binance.US spot accounts can only buy then sell, so Entryvex only suggests buy-first trades.
- **Data sources:** Binance.US market data, CoinGecko coin data, and public news feeds (Cointelegraph, Decrypt, CoinDesk, Bitcoin Magazine, Google News, Bing News).
- **Honesty first:** every confidence number in Entryvex is measured from real past data and checked again live. When the numbers say "don't trade", Entryvex says so.
