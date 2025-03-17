import { elizaLogger } from "@elizaos/core";
import { TokenProvider } from "../providers/token";
import { TrustScoreProvider } from "../providers/trustScoreProvider";

/**
 * SimulationService simulates a trade for a given token and amount.
 * It evaluates token trust score and computes the price impact based on liquidity,
 * then returns:
 *   - expectedPrice: current token price (USD)
 *   - priceImpact: estimated price impact in percentage
 *   - recommendedAction: "EXECUTE" if conditions are met, otherwise "ABORT"
 *   - reason: explanation for the decision
 */
export class SimulationService {
  private trustScoreProvider: TrustScoreProvider;

  constructor() {
    this.trustScoreProvider = new TrustScoreProvider();
  }

  async simulateTrade(
    tokenAddress: string,
    amount: number
  ): Promise<{
    expectedPrice: number;
    priceImpact: number;
    recommendedAction: "EXECUTE" | "ABORT";
    reason: string;
  }> {
    try {
      // Evaluate the token using TrustScoreProvider
      const evaluation = await this.trustScoreProvider.evaluateToken(tokenAddress);
      // Get processed token data (including market metrics)
      const tokenProvider = new TokenProvider(tokenAddress);
      const tokenData = await tokenProvider.getProcessedTokenData();

      // Extract liquidity (USD) from the first DexScreener pair
      const liquidity = tokenData.dexscreenerData.pairs[0]?.liquidity?.usd || 0;
      // Calculate price impact as percentage: (amount / liquidity) * 100
      const priceImpact = (amount / liquidity) * 100;

      // Initialize recommendation with default values
      let recommendedAction: "EXECUTE" | "ABORT" = "ABORT";
      let reason = "Default safety check failed";

      // If trust score is above threshold and price impact is small, recommend execution
      if (evaluation.trustScore > 0.4 && priceImpact < 1) {
        recommendedAction = "EXECUTE";
        reason = "Trade meets safety parameters";
      }

      return {
        expectedPrice: tokenData.tradeData.price,
        priceImpact,
        recommendedAction,
        reason,
      };
    } catch (error) {
      elizaLogger.error("Trade simulation failed:", error);
      throw error;
    }
  }
}
