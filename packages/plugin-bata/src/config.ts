// Configuration for providers and chain specifics.
export const PROVIDER_CONFIG = {
  BIRDEYE_API: "https://public-api.birdeye.so",
  TOKEN_SECURITY_ENDPOINT: "/defi/token_security?address=",
  TOKEN_METADATA_ENDPOINT: "/defi/v3/token/meta-data/single?address=",
  MARKET_SEARCH_ENDPOINT: "/defi/v3/token/trade-data/single?address=",
  TOKEN_PRICE_CHANGE_ENDPOINT:
    "/defi/v3/search?chain=solana&target=token&sort_by=price_change_24h_percent&sort_type=desc&verify_token=true&markets=Raydium&limit=20",
  TOKEN_VOLUME_24_CHANGE_ENDPOINT:
    "/defi/v3/search?chain=solana&target=token&sort_by=volume_24h_change_percent&sort_type=desc&verify_token=true&markets=Raydium&limit=20",
  TOKEN_BUY_24_CHANGE_ENDPOINT:
    "/defi/v3/search?chain=solana&target=token&sort_by=buy_24h_change_percent&sort_type=desc&verify_token=true&markets=Raydium&offset=0&limit=20",

  TOKEN_SECURITY_ENDPOINT_BASE: "/defi/token_security?address=",
  TOKEN_METADATA_ENDPOINT_BASE: "/defi/v3/token/meta-data/single?address=",
  MARKET_SEARCH_ENDPOINT_BASE: "/defi/v3/token/trade-data/single?address=",
  TOKEN_PRICE_CHANGE_ENDPOINT_BASE:
    "/defi/v3/search?chain=base&target=token&sort_by=price_change_24h_percent&sort_type=desc&offset=0&limit=20",
  TOKEN_VOLUME_24_ENDPOINT_BASE:
    "/defi/v3/search?chain=base&target=token&sort_by=volume_24h_usd&sort_type=desc&offset=2&limit=20",
  TOKEN_BUY_24_ENDPOINT_BASE:
    "/defi/v3/search?chain=base&target=token&sort_by=buy_24h&sort_type=desc&offset=2&limit=20",

  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
};

export const CHAIN_CONFIG = {
  BNB_ENABLED: true,
  SOLANA_ENABLED: false,
  BASE_ENABLED: false,
};

export const BNB_CONFIG = {
  RPC_URL: process.env.BSC_PROVIDER_URL || "https://bsc-dataseed.binance.org/",
  ROUTER_ADDRESS: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  WBNB_ADDRESS: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  CHAIN_ID: 56,
  STABLECOINS: {
    BUSD: "0xe9e7cea3dedca5984780bafc599bd69add087d56",
    USDT: "0x55d398326f99059ff775485246999027b3197955",
    USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  },
};

export const ZEROEX_CONFIG = {
  API_URL: "https://api.0x.org",
  API_KEY: process.env.ZEROEX_API_KEY || "",
  QUOTE_ENDPOINT: "/swap/permit2/quote",
  PRICE_ENDPOINT: "/swap/permit2/price",
  SUPPORTED_CHAINS: { BSC: 56 },
  HEADERS: {
    "Content-Type": "application/json",
    "0x-api-key": process.env.ZEROEX_API_KEY || "",
    "0x-version": "v2",
  },
};

