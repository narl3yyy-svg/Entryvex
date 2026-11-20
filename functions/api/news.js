// Cloudflare Pages Function: GET /api/news?coin=BTC
//
// Browsers can't read most RSS feeds directly (CORS), so this small server
// function fetches several crypto news feeds, merges them, tags which coins
// each headline mentions, and returns clean JSON. Results are cached at the
// edge for a few minutes so the feeds aren't hammered.

const GENERAL_FEEDS = [
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/" },
];

// Keep in sync with public/js/coins.js (duplicated so the function has no build step).
const COIN_KEYWORDS = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "ether", "eth"], SOL: ["solana"],
  XRP: ["xrp", "ripple"], DOGE: ["dogecoin", "doge"], ADA: ["cardano"],
  AVAX: ["avalanche", "avax"], LINK: ["chainlink"], LTC: ["litecoin", "ltc"],
  DOT: ["polkadot"], BCH: ["bitcoin cash"], SHIB: ["shiba inu", "shib"],
  SUI: ["sui"], XLM: ["stellar", "xlm"], HBAR: ["hedera", "hbar"],
  UNI: ["uniswap"], AAVE: ["aave"], MATIC: ["polygon", "matic"], POL: ["polygon"],
  ATOM: ["cosmos"], NEAR: ["near protocol"], PEPE: ["pepe"], BNB: ["bnb"],
  USDT: ["tether", "usdt"], USDC: ["usdc"],
};
const COIN_NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", DOGE: "Dogecoin",
  ADA: "Cardano", AVAX: "Avalanche", LINK: "Chainlink", LTC: "Litecoin",
  DOT: "Polkadot", BCH: "Bitcoin Cash", SHIB: "Shiba Inu", SUI: "Sui crypto",
  XLM: "Stellar", HBAR: "Hedera", UNI: "Uniswap", AAVE: "Aave", MATIC: "Polygon",
  POL: "Polygon", ATOM: "Cosmos crypto", NEAR: "NEAR Protocol", PEPE: "Pepe coin",
  BNB: "BNB",
};

const CACHE_SECONDS = 180;
const MAX_ITEMS = 60;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const coin = (url.searchParams.get("coin") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

  const cacheKey = new Request(`${url.origin}/api/news?coin=${coin}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const feeds = [...GENERAL_FEEDS];
  if (coin) {
    const q = `"${COIN_NAMES[coin] || coin}" crypto when:2d`;
    feeds.push({
      source: "Google News",
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
      perCoin: true,
    });
  }

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  let items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else failed.push(feeds[i].source);
  });

  // De-duplicate by normalized title, tag coins, sort newest first.
  const seen = new Set();
  items = items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const it of items) it.coins = tagCoins(it.title + " " + (it.summary || ""));
  if (coin) {
    items = items.filter((it) => it.perCoin || it.coins.includes(coin));
  }
  items.sort((a, b) => (b.published || 0) - (a.published || 0));
  items = items.slice(0, MAX_ITEMS).map(({ perCoin, ...rest }) => rest);

  const body = JSON.stringify({ coin: coin || null, updated: Date.now(), failedSources: failed, items });
  const res = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  if (cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Entryvex/0.1; +https://github.com/narl3yyy-svg/Entryvex)" },
    redirect: "follow",
    cf: { cacheTtl: CACHE_SECONDS },
  });
  if (!res.ok) throw new Error(`${feed.source}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml).map((it) => {
    let source = feed.source;
    let title = it.title;
    // Google News titles look like "Headline - Publisher".
    if (feed.perCoin) {
      const m = title.match(/^(.*) - ([^-]{2,60})$/);
      if (m) { title = m[1]; source = m[2]; }
    }
    return { ...it, title, source, perCoin: !!feed.perCoin };
  });
}

// Minimal RSS 2.0 / Atom parser (Workers have no DOMParser).
function parseFeed(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 50)) {
    const title = clean(tag(b, "title"));
    let link = clean(tag(b, "link"));
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const summary = clean(tag(b, "description") || tag(b, "summary")).slice(0, 280);
    const published = date ? Date.parse(clean(date)) || null : null;
    if (title && /^https?:\/\//.test(link)) out.push({ title, link, published, summary });
  }
  return out;
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function clean(s) {
  return decode(
    String(s)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function tagCoins(text) {
  const t = " " + text.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  const found = [];
  for (const [sym, words] of Object.entries(COIN_KEYWORDS)) {
    if (words.some((w) => t.includes(` ${w} `))) found.push(sym);
  }
  return found;
}
