import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";
import { elizaLogger, settings } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import { bnbPlugin } from "@elizaos/plugin-bnb"; // plugin-bnb's base plugin
import NodeCache from "node-cache";
import * as fs from "fs";
import * as path from "path";
import { updateSellDetails } from "./services/tradePerformance";

import { analyzeTradeAction } from "./actions/analyzeTrade";
import { trustEvaluator } from "./evaluators/trust";
import { TrustScoreProvider } from "./providers/trustScoreProvider";
import { SimulationService } from "./services/simulationService";
import { TwitterService, tweetTrade } from "./services/twitter";
import { SAFETY_LIMITS, MARKET_SEARCH_INTERVAL } from "./constants";
import { executeTrade, getWalletBalance, getWalletKeypair } from "./wallet";
import type { ProcessedTokenData, TradePosition } from "./types";

// Load token addresses from configuration file
function loadTokenAddresses(): string[] {
  try {
    const filePath = path.resolve(process.cwd(), "../characters/tokens/tokenaddresses.json");
    const data = fs.readFileSync(filePath, "utf8");
    const addresses: string[] = JSON.parse(data);
    const validAddresses = addresses.filter(addr => /^0x[a-fA-F0-9]{40}$/.test(addr));
    elizaLogger.log("Loaded token addresses:", { total: validAddresses.length });
    return validAddresses;
  } catch (error) {
    elizaLogger.error("Failed to load token addresses:", error);
    return [];
  }
}

// Create caches for token analysis and tweet rate limiting
const tokenCache = new NodeCache({ stdTTL: 1200, checkperiod: 120 });
const tweetRateCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

function canTweet(type: "trade" | "market_search"): boolean {
  const now = Date.now();
  const hourKey = `${type}_${Math.floor(now / 3600000)}`;
  const count = tweetRateCache.get<number>(hourKey) || 0;
  const maxAllowed = MAX_TWEETS_PER_HOUR[type] || 10;
  if (count >= maxAllowed) {
    elizaLogger.warn(`Tweet rate limit reached for ${type}: ${count}`);
    return false;
  }
  tweetRateCache.set(hourKey, count + 1);
  return true;
}

// Main plugin object: merges plugin-bnb's providers/actions with custom ones
const plugin: Plugin = {
  name: "plugin-bata",
  description: "BNB Automated Trading Agent plugin for Eliza (BATA)",
  providers: [
    new TrustScoreProvider(),
    ...(bnbPlugin.providers || [])
  ],
  actions: [
    analyzeTradeAction,
    ...(bnbPlugin.actions || [])
  ],
  evaluators: [trustEvaluator],
  services: [],
  autoStart: true,
  onLoad: async (runtime: IAgentRuntime) => {
    elizaLogger.log("BATA plugin loaded. Initializing services...");

    let twitterService: TwitterService | null = null;
    if (settings.TWITTER_ENABLED && runtime.getClient) {
      const twitterClient = runtime.getClient("twitter") as TwitterClientInterface;
      const twitterUsername = settings.TWITTER_USERNAME || "";
      twitterService = new TwitterService(twitterClient, { enabled: true, username: twitterUsername });
      plugin.services.push(twitterService);
      elizaLogger.log("TwitterService initialized for:", twitterUsername);
    }

    const watchlist = loadTokenAddresses();
    if (watchlist.length === 0) {
      elizaLogger.warn("No token addresses to monitor.");
    }

    // Main monitoring loop (every MARKET_SEARCH_INTERVAL)
    setInterval(async () => {
      for (const tokenAddress of watchlist) {
        try {
          if (tokenCache.get(tokenAddress)) continue;

          const trustProvider = new TrustScoreProvider();
          const trustEval = await trustProvider.evaluateToken(tokenAddress);
          const { trustScore, riskLevel, tradingAdvice } = trustEval;
          elizaLogger.log(`Trust evaluation for ${tokenAddress}: score=${trustScore.toFixed(2)}, risk=${riskLevel}, advice=${tradingAdvice}`);

          // Retrieve market data (including DexScreener data) from the provider
          const tokenProvider = new TrustScoreProvider();
          const tokenDataResult = await tokenProvider.getTokenProvider(tokenAddress).getProcessedTokenData();

          const analysisParams = {
            walletBalance: await getWalletBalance(runtime),
            tokenAddress,
            price: tokenDataResult.tradeData.price,
            volume: tokenDataResult.tradeData.volume24h,
            marketCap: tokenDataResult.dexScreenerData.pairs[0].marketCap || 0,
            liquidity: tokenDataResult.dexScreenerData.pairs[0].liquidity.usd,
            holderDistribution: tokenDataResult.holderDistributionTrend,
            trustScore,
            dexscreener: tokenDataResult.dexScreenerData,
            position: null as TradePosition | null,
          };

          // Run AI analysis via analyzeTradeAction
          const memory: Memory = {
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content: {}
          };
          const state: State | undefined = undefined;
          let analysisResult: any = null;
          await analyzeTradeAction.handler(runtime, memory, state, analysisParams, (result) => {
            if (result.type === "analysis") {
              analysisResult = JSON.parse(result.text);
            }
          });
          if (!analysisResult) {
            elizaLogger.warn("AI analysis failed for", tokenAddress);
            continue;
          }
          elizaLogger.log("AI analysis result:", analysisResult);

          // Use SimulationService to check trade safety
          const simulationService = new SimulationService();
          const sim = await simulationService.simulateTrade(tokenAddress, SAFETY_LIMITS.MINIMUM_TRADE);
          if (sim.recommendedAction === "EXECUTE" && analysisResult.recommendation === "BUY") {
            const walletBal = await getWalletBalance(runtime);
            const tradeAmount = Math.min(SAFETY_LIMITS.MINIMUM_TRADE, walletBal * 0.95);
            if (tradeAmount < SAFETY_LIMITS.MINIMUM_TRADE) {
              elizaLogger.warn(`Insufficient BNB balance: ${walletBal} BNB`);
              continue;
            }
            // Execute trade using plugin-bnb's swap API via our wallet module
            const tradeResult = await executeTrade(runtime, {
              tokenAddress,
              amount: tradeAmount,
              slippage: SAFETY_LIMITS.MAX_SLIPPAGE,
              isSell: false,
            });
            if (tradeResult.success) {
              elizaLogger.log(`Trade executed for ${tokenAddress}:`, { hash: tradeResult.hash, amount: tradeAmount });
              
              // Trade performance update integration from rabbi‑trader 
              try {
                const recommenderId = "default-recommender"; 
                const performanceUpdate = await updateSellDetails(runtime, tokenAddress, recommenderId, tradeAmount, null, tokenDataResult);
                elizaLogger.log("Trade performance updated:", performanceUpdate);
              } catch (error) {
                elizaLogger.error("Failed to update trade performance:", error);
              }

              if (twitterService && canTweet("trade")) {
                await tweetTrade(twitterService, {
                  token: tokenDataResult.dexScreenerData.pairs[0]?.baseToken.symbol || tokenAddress,
                  tokenAddress,
                  amount: tradeAmount,
                  price: tokenDataResult.tradeData.price,
                  action: "BUY",
                  trustScore,
                  riskLevel,
                  txHash: tradeResult.hash,
                });
              }
            } else {
              elizaLogger.error("Trade execution failed:", tradeResult.error);
            }
          }
          tokenCache.set(tokenAddress, {
            lastAnalysis: Date.now(),
            tokenData: tokenDataResult,
            trustScore,
            analysisResult,
          });
        } catch (err) {
          elizaLogger.error(`Error in monitoring loop for ${tokenAddress}:`, err);
        }
      }
    }, MARKET_SEARCH_INTERVAL);
  },
};

export default plugin;
