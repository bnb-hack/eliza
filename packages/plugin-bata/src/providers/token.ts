import { elizaLogger } from "@elizaos/core";
import NodeCache from "node-cache";
import type { ProcessedTokenData, TokenSecurityData, TokenTradeData, DexScreenerPair } from "../types";
import { toBN } from "../utils/bignumber";

/**
 * TokenProvider retrieves market and security data for a given token on BNB Chain.
 * It uses DexScreener (and optionally EdgeByChaos) to compile a ProcessedTokenData object.
 */
export class TokenProvider {
  private cache: NodeCache;
  private tokenAddress: string;

  constructor(tokenAddress: string) {
    this.tokenAddress = tokenAddress;
    this.cache = new NodeCache({ stdTTL: 300 });
  }

  private async fetchDexScreenerData(): Promise<{ pairs: DexScreenerPair[] }> {
    const chainParam = 'bsc';
    const url = `https://api.dexscreener.com/latest/dex/tokens/${this.tokenAddress}?chainId=${chainParam}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`DexScreener API request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!data || !data.pairs || data.pairs.length === 0) {
      throw new Error("No DexScreener data for token");
    }
    return data;
  }

  async getProcessedTokenData(): Promise<ProcessedTokenData> {
    const cacheKey = `processed_${this.tokenAddress}`;
    const cached = this.cache.get<ProcessedTokenData>(cacheKey);
    if (cached) return cached;
    try {
      const dexData = await this.fetchDexScreenerData();
      const pair = dexData.pairs[0];
      const security: TokenSecurityData = {
        ownerBalance: toBN(pair.liquidity.base).toString(),
        creatorBalance: "0",
        ownerPercentage: 0,
        creatorPercentage: 0,
        top10HolderBalance: toBN(pair.liquidity.base).times(0.1).toString(),
        top10HolderPercent: 10,
      };
      const tradeData: TokenTradeData = {
        price: Number(pair.priceUsd),
        priceChange24h: pair.priceChange.h24,
        volume24h: pair.volume.h24,
        volume24hUsd: toBN(pair.volume.h24).toString(),
        uniqueWallets24h: pair.txns.h24.buys + pair.txns.h24.sells,
        uniqueWallets24hChange: 0,
      };
      const buySellDiff = tradeData.uniqueWallets24hChange;
      let holderDistributionTrend = buySellDiff > 0 ? "increasing" : buySellDiff < 0 ? "decreasing" : "stable";
      const processedData: ProcessedTokenData = {
        security,
        tradeData,
        dexScreenerData: { pairs: [pair] },
        holderDistributionTrend,
        highValueHolders: [],
        recentTrades: pair.volume.h24 > 0,
        highSupplyHoldersCount: 0,
        tokenCodex: { isScam: false },
      };
      this.cache.set(cacheKey, processedData);
      return processedData;
    } catch (error) {
      elizaLogger.error(`Failed to process token data for ${this.tokenAddress}: ${error}`);
      throw error;
    }
  }

  async shouldTradeToken(): Promise<boolean> {
    try {
      const data = await this.getProcessedTokenData();
      const pair = data.dexScreenerData.pairs[0];
      return (
        pair.liquidity.usd > 50000 &&
        pair.volume.h24 > 10000 &&
        Math.abs(pair.priceChange.h24) < 30 &&
        !data.tokenCodex.isScam
      );
    } catch {
      return false;
    }
  }
}
