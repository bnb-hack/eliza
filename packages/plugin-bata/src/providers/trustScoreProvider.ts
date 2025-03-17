import { elizaLogger } from "@elizaos/core";
import { TokenProvider } from "./token";
import type { ProcessedTokenData } from "../types";
import { SAFETY_LIMITS } from "../constants";

export class TrustScoreProvider {
  private tokenProviders: Map<string, TokenProvider> = new Map();

  private getTokenProvider(tokenAddress: string): TokenProvider {
    if (!this.tokenProviders.has(tokenAddress)) {
      this.tokenProviders.set(tokenAddress, new TokenProvider(tokenAddress));
    }
    return this.tokenProviders.get(tokenAddress)!;
  }

  async calculateTrustScore(tokenData: ProcessedTokenData): Promise<number> {
    const pair = tokenData.dexScreenerData.pairs[0];
    const { liquidity, volume, marketCap } = pair;
    const LIQUIDITY_WEIGHT = 0.4;
    const VOLUME_WEIGHT = 0.4;
    const MCAP_WEIGHT = 0.2;
    const liquidityScore = Math.min((liquidity.usd || 0) / 100000, 1) * LIQUIDITY_WEIGHT;
    const volumeScore = Math.min((volume.h24 || 0) / 50000, 1) * VOLUME_WEIGHT;
    const mcapScore = Math.min((marketCap || 0) / 1000000, 1) * MCAP_WEIGHT;
    return liquidityScore + volumeScore + mcapScore;
  }

  async evaluateToken(tokenAddress: string): Promise<{
    trustScore: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    tradingAdvice: "BUY" | "SELL" | "HOLD";
    reason: string;
  }> {
    try {
      const provider = this.getTokenProvider(tokenAddress);
      const tokenData = await provider.getProcessedTokenData();
      const trustScore = await this.calculateTrustScore(tokenData);
      const pair = tokenData.dexScreenerData.pairs[0];

      // 根据 trustScore 划分风险等级
      const riskLevel: "LOW" | "MEDIUM" | "HIGH" =
        trustScore > 0.7 ? "LOW" : trustScore > 0.4 ? "MEDIUM" : "HIGH";

      // 基于价格变化和 trustScore 生成交易建议
      let tradingAdvice: "BUY" | "SELL" | "HOLD" = "HOLD";
      let reason = "Market conditions stable";
      if (pair.priceChange.h24 > 5 && trustScore > 0.4) {
        tradingAdvice = "BUY";
        reason = "Strong upward momentum with good trust score";
      } else if (pair.priceChange.h24 < -10 || trustScore < 0.3) {
        tradingAdvice = "SELL";
        reason = "Deteriorating conditions or low trust score";
      }

      return { trustScore, riskLevel, tradingAdvice, reason };
    } catch (error) {
      elizaLogger.error(`Trust evaluation failed for ${tokenAddress}: ${error}`);
      throw error;
    }
  }
}
