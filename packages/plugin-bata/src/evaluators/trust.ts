import { type IAgentRuntime, type Memory, type Evaluator, elizaLogger } from "@elizaos/core";
import { TrustScoreProvider } from "../providers/trustScoreProvider";

/**
 * Evaluator: Evaluates token trust scores and trading signals.
 * This evaluator extracts tokenAddress from the incoming message, then uses
 * TrustScoreProvider to compute the trust score, risk level, and trading advice.
 * It logs the evaluation and returns a boolean indicating success.
 */
export const trustEvaluator: Evaluator = {
  name: "EVALUATE_TRUST",
  similes: [],
  examples: [],
  description: "Evaluates token trust scores and trading signals",
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const trustScoreProvider = new TrustScoreProvider();
    const tokenAddress = message.content?.tokenAddress;
    
    if (!tokenAddress) {
      elizaLogger.error("Trust evaluation failed: tokenAddress is missing in message content.");
      return false;
    }
    
    try {
      const evaluation = await trustScoreProvider.evaluateToken(tokenAddress);
      elizaLogger.log("Trust evaluation:", {
        tokenAddress,
        ...evaluation,
      });
      return true;
    } catch (error) {
      elizaLogger.error("Trust evaluation failed:", error);
      return false;
    }
  },
};
