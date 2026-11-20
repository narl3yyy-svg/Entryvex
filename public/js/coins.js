// Friendly names + search keywords for common coins.
// Used for display and to match news headlines to a coin.
export const COINS = {
  BTC: { name: "Bitcoin", keywords: ["bitcoin", "btc"] },
  ETH: { name: "Ethereum", keywords: ["ethereum", "ether", "eth"] },
  SOL: { name: "Solana", keywords: ["solana", "sol"] },
  XRP: { name: "XRP", keywords: ["xrp", "ripple"] },
  DOGE: { name: "Dogecoin", keywords: ["dogecoin", "doge"] },
  ADA: { name: "Cardano", keywords: ["cardano", "ada"] },
  AVAX: { name: "Avalanche", keywords: ["avalanche", "avax"] },
  LINK: { name: "Chainlink", keywords: ["chainlink"] },
  LTC: { name: "Litecoin", keywords: ["litecoin", "ltc"] },
  DOT: { name: "Polkadot", keywords: ["polkadot"] },
  BCH: { name: "Bitcoin Cash", keywords: ["bitcoin cash", "bch"] },
  SHIB: { name: "Shiba Inu", keywords: ["shiba inu", "shib"] },
  SUI: { name: "Sui", keywords: ["sui"] },
  XLM: { name: "Stellar", keywords: ["stellar", "xlm"] },
  HBAR: { name: "Hedera", keywords: ["hedera", "hbar"] },
  UNI: { name: "Uniswap", keywords: ["uniswap"] },
  AAVE: { name: "Aave", keywords: ["aave"] },
  MATIC: { name: "Polygon", keywords: ["polygon", "matic"] },
  POL: { name: "Polygon", keywords: ["polygon"] },
  ATOM: { name: "Cosmos", keywords: ["cosmos", "atom"] },
  NEAR: { name: "NEAR Protocol", keywords: ["near protocol"] },
  PEPE: { name: "Pepe", keywords: ["pepe"] },
  BNB: { name: "BNB", keywords: ["bnb", "binance coin"] },
  USDT: { name: "Tether", keywords: ["tether", "usdt"] },
  USDC: { name: "USD Coin", keywords: ["usdc", "circle"] },
};

export function coinName(base) {
  return COINS[base]?.name ?? base;
}

export const DEFAULT_WATCHLIST = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
  "AVAXUSDT", "LINKUSDT", "LTCUSDT", "DOTUSDT", "BCHUSDT", "SUIUSDT",
];
