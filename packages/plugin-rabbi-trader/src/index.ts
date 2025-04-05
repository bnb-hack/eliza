import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";
import { elizaLogger, settings } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
// Remove Solana-specific imports
// import {
//   solanaPlugin,
//   trustScoreProvider,
//   trustEvaluator,
//   getTokenBalance,
// } from "@elizaos/plugin-solana";
import { TokenProvider } from "./providers/token";
// Replace Solana imports with ethers
// import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import type { WalletClient, Signature, Balance } from "@goat-sdk/core";
import * as fs from "fs";
import * as path from "path";
import { TrustScoreProvider } from "./providers/trustScoreProvider";
import { SimulationService } from "./services/simulationService";
import { SAFETY_LIMITS } from "./constants";
import NodeCache from "node-cache";
import { TrustScoreDatabase } from "@elizaos/plugin-trustdb";
import { v4 as uuidv4 } from "uuid";
import { actions } from "./actions";
import {
  tweetTrade,
  TwitterConfigSchema,
  TwitterService,
} from "./services/twitter";
import {
  executeTrade,
  getChainWalletBalance,
  getWalletBalance,
  // getWalletKeypair, // Remove Solana-specific function
} from "./wallet";
import type { ProcessedTokenData } from "./types";
import { analyzeTradeAction } from "./actions/analyzeTrade";

// Update Balance interface to include formatted
interface ExtendedBalance extends Balance {
  formatted: string;
}

interface ProviderResult {
  values?: { [key: string]: any };
  data?: { [key: string]: any };
  text?: string;
}

// Updated WalletProvider interface for BSC
interface ExtendedWalletProvider extends WalletClient {
  provider: ethers.providers.JsonRpcProvider; // Changed from Connection to provider
  signMessage(message: string): Promise<Signature>;
  getFormattedPortfolio: (runtime: IAgentRuntime) => Promise<string>;
  balanceOf: (tokenAddress: string) => Promise<ExtendedBalance>;
  getMaxBuyAmount: (tokenAddress: string) => Promise<number>;
  executeTrade: (params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    slippage: number;
  }) => Promise<any>;

  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<ProviderResult>;
}

const REQUIRED_SETTINGS = {
  BSC_WALLET_ADDRESS: "BSC wallet address",
  BSC_PRIVATE_KEY: "BSC wallet private key",
  DEXSCREENER_WATCHLIST_ID: "DexScreener watchlist ID",
  COINGECKO_API_KEY: "CoinGecko API key",
} as const;

// Add near the top imports
interface ExtendedPlugin extends Plugin {
  name: string;
  description: string;
  evaluators: any[];
  providers: any[];
  actions: any[];
  services: any[];
  autoStart?: boolean;
}

// Replace Solana validation with BSC validation
function validateBscAddress(address: string | undefined): boolean {
  if (!address) return false;
  try {
    // Handle BSC addresses
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      elizaLogger.warn(`BSC address failed format check: ${address}`);
      return false;
    }

    // Verify it's a valid BSC address
    const isValid = ethers.utils.isAddress(address);
    elizaLogger.info(
      `BSC address validation result for ${address}: ${isValid}`
    );
    return isValid;
  } catch (error) {
    elizaLogger.error(`Address validation error for ${address}:`, error);
    return false;
  }
}

// Update function to load token addresses
export function loadTokenAddresses(): string[] {
  try {
    const filePath = path.resolve(
      process.cwd(),
      "../characters/tokens/tokenaddresses.json"
    );
    const data = fs.readFileSync(filePath, "utf8");
    const addresses = JSON.parse(data);

    // Validate addresses
    const validAddresses = addresses.filter((addr: string) => {
      // BSC address validation (starts with 0x)
      return validateBscAddress(addr);
    });

    elizaLogger.info("Loaded token addresses:", {
      total: validAddresses.length,
      bsc: validAddresses.length,
    });

    return validAddresses;
  } catch (error) {
    elizaLogger.error("Failed to load token addresses:", error);
    throw new Error("Token addresses file not found or invalid");
  }
}

// Add cache configuration after other interfaces
interface CacheEntry {
  lastAnalysis: number;
  tokenData: any;
  trustScore: number;
  analysisResult: any;
}

// Add cache instance before createPlugin
const tokenCache = new NodeCache({
  stdTTL: 1200, // 20 minutes in seconds
  checkperiod: 120, // Check for expired entries every 2 minutes
});

// Add new interfaces near the top with other interfaces
interface TradePerformance {
  token_address: string;
  recommender_id: string;
  buy_price: number;
  sell_price: number;
  buy_timeStamp: string;
  sell_timeStamp: string;
  buy_amount: number;
  sell_amount: number;
  buy_value_usd: number;
  sell_value_usd: number;
  buy_market_cap: number;
  sell_market_cap: number;
  buy_liquidity: number;
  sell_liquidity: number;
  profit_usd: number;
  profit_percent: number;
  market_cap_change: number;
  liquidity_change: number;
  rapidDump: boolean;
}

interface TradePosition {
  token_address: string;
  entry_price: number;
  size: number;
  stop_loss: number;
  take_profit: number;
  open_timeStamp: string;
  close_timeStamp?: string;
  status?: "OPEN" | "CLOSED";
}

// Update the analysisParams interface
interface AnalysisParams extends Record<string, any> {
  walletBalance: number;
  tokenAddress: string;
  price: number;
  volume: number;
  marketCap: number;
  liquidity: number;
  holderDistribution: string;
  trustScore: number;
  dexscreener: any;
  position?: TradePosition;
  tradeHistory?: TradePerformance[];
}

// Update the interface to match the SQL parameter order
interface SellDetailsData {
  // SET clause parameters in order
  sell_price: number;
  sell_timeStamp: string;
  sell_amount: number;
  received_sol: number; // Keep field name for compatibility but it's BNB
  sell_value_usd: number;
  profit_usd: number;
  profit_percent: number;
  sell_market_cap: number;
  market_cap_change: number;
  sell_liquidity: number;
  liquidity_change: number;
  rapidDump: boolean;
  sell_recommender_id: string | null;
}

async function updateSellDetails(
  runtime: IAgentRuntime,
  tokenAddress: string,
  recommenderId: string,
  tradeAmount: number,
  latestTrade: any,
  tokenData: any
) {
  const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

  const trade = await trustScoreDb.getLatestTradePerformance(
    tokenAddress,
    recommenderId,
    false
  );

  if (!trade) {
    elizaLogger.error(
      `No trade found for token ${tokenAddress} and recommender ${recommenderId}`
    );
    throw new Error("No trade found to update");
  }

  const currentPrice = tokenData.dexScreenerData.pairs[0]?.priceUsd || 0;
  const marketCap = tokenData.dexScreenerData.pairs[0]?.marketCap || 0;
  const liquidity = tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0;

  const sellValueUsd = tradeAmount * Number(currentPrice);
  const profitUsd = sellValueUsd - trade.buy_value_usd;
  const profitPercent = (profitUsd / trade.buy_value_usd) * 100;

  // Create sellDetailsData object matching SQL parameter order
  const sellDetails: SellDetailsData = {
    sell_price: Number(currentPrice),
    sell_timeStamp: new Date().toISOString(),
    sell_amount: tradeAmount,
    received_sol: tradeAmount, // This is actually BNB but keep field name for compatibility
    sell_value_usd: sellValueUsd,
    profit_usd: profitUsd,
    profit_percent: profitPercent,
    sell_market_cap: marketCap,
    market_cap_change: marketCap - trade.buy_market_cap,
    sell_liquidity: liquidity,
    liquidity_change: liquidity - trade.buy_liquidity,
    rapidDump: false,
    sell_recommender_id: recommenderId || null,
  };

  elizaLogger.info("Attempting to update trade performance with data:", {
    sellDetails,
    whereClause: {
      tokenAddress,
      recommenderId,
      buyTimeStamp: trade.buy_timeStamp,
    },
    isSimulation: false,
  });

  try {
    try {
      // Pass sellDetails first (SET clause), then WHERE clause parameters
      elizaLogger.info(
        "Verifying parameters for updateTradePerformanceOnSell:",
        {
          sellDetails,
          tokenAddress,
          recommenderId,
          buyTimeStamp: trade.buy_timeStamp,
          isSimulation: false,
        }
      );

      const success = await trustScoreDb.updateTradePerformanceOnSell(
        tokenAddress, // 1. WHERE token_address = ?
        recommenderId, // 2. WHERE recommender_id = ?
        trade.buy_timeStamp, // 3. WHERE buy_timeStamp = ?
        sellDetails, // 4. SET clause parameters
        false // 5. isSimulation flag
      );

      if (!success) {
        elizaLogger.warn("Trade update returned false", {
          tokenAddress,
          recommenderId,
          buyTimeStamp: trade.buy_timeStamp,
        });
      }

      elizaLogger.info("Trade performance update completed", {
        success,
        tokenAddress,
        recommenderId,
        profitPercent: profitPercent.toFixed(2) + "%",
        profitUsd: profitUsd.toFixed(4) + " USD",
      });
    } catch (dbError) {
      elizaLogger.error("Database error during trade update:", {
        error: dbError,
        query: {
          sellDetails,
          whereClause: {
            tokenAddress,
            recommenderId,
            buyTimeStamp: trade.buy_timeStamp,
          },
        },
      });
      throw dbError;
    }
  } catch (error) {
    elizaLogger.error("Failed to update trade performance:", {
      error,
      parameters: {
        sellDetails,
        whereClause: {
          tokenAddress,
          recommenderId,
          buyTimeStamp: trade.buy_timeStamp,
        },
        originalTrade: trade,
      },
      errorDetails:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            }
          : error,
    });
    throw error;
  }

  return {
    sellDetails,
    currentPrice,
    profitDetails: {
      profitUsd,
      profitPercent,
      sellValueUsd,
    },
  };
}

// Update the module declaration to match the new parameter order
declare module "@elizaos/plugin-trustdb" {
  interface TrustScoreDatabase {
    updateTradePerformanceOnSell(
      tokenAddress: string, // Changed order: tokenAddress first
      recommenderId: string, // recommenderId second
      buyTimeStamp: string, // buyTimeStamp third
      sellDetails: SellDetailsData, // sellDetails fourth
      isSimulation: boolean // isSimulation fifth
    ): boolean;
  }
}

// Replace Solana chain balance with BSC chain balance
async function getChainBalance(
  provider: ethers.providers.JsonRpcProvider,
  walletAddress: string,
  tokenAddress: string
): Promise<number> {
  try {
    // Check if this is the native BNB token
    if (tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
        tokenAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      // Get native BNB balance
      const balance = await provider.getBalance(walletAddress);
      return parseFloat(ethers.utils.formatEther(balance));
    } else {
      // Get BEP-20 token balance
      const tokenAbi = ["function balanceOf(address) view returns (uint256)", 
                        "function decimals() view returns (uint8)"];
      const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
      
      const balance = await tokenContract.balanceOf(walletAddress);
      const decimals = await tokenContract.decimals();
      
      return parseFloat(ethers.utils.formatUnits(balance, decimals));
    }
  } catch (error) {
    elizaLogger.error(`Error getting balance for ${tokenAddress}:`, error);
    return 0;
  }
}

async function createRabbiTraderPlugin(
  getSetting: (key: string) => string | undefined,
  runtime?: IAgentRuntime
): Promise<Plugin> {
  elizaLogger.info("createRabbiTraderPlugin starting");

  // Define resumeTrading at the start of the function
  const resumeTrading = async () => {
    // Load and analyze tokens
    const tokenAddresses = loadTokenAddresses();
    elizaLogger.info(`Analyzing ${tokenAddresses.length} BSC tokens...`);

    // Analyze tokens
    for (const tokenAddress of tokenAddresses) {
      await analyzeToken(runtime, provider, twitterService, tokenAddress);
    }

    // Add delay between iterations
    await new Promise((resolve) => setTimeout(resolve, 30000));
  };

  elizaLogger.info("Starting plugin initialization");

  // Initialize BSC provider and wallet
  const bscRpcUrl = runtime?.getSetting("BSC_RPC_URL") || 
    "https://bsc-dataseed1.binance.org/";
  const provider = new ethers.providers.JsonRpcProvider(bscRpcUrl);
  
  const privateKey = runtime?.getSetting("BSC_PRIVATE_KEY");
  const walletAddress = runtime?.getSetting("BSC_WALLET_ADDRESS");
  
  let wallet;
  if (privateKey) {
    wallet = new ethers.Wallet(privateKey, provider);
    elizaLogger.info("BSC wallet initialized with private key");
  } else if (walletAddress) {
    elizaLogger.info(`BSC wallet set to address: ${walletAddress}`);
  } else {
    elizaLogger.error("No BSC wallet configured");
  }

  // Validate required settings
  const missingSettings: string[] = [];
  for (const [key, description] of Object.entries(REQUIRED_SETTINGS)) {
    if (!getSetting(key)) {
      missingSettings.push(`${key} (${description})`);
    }
  }

  if (missingSettings.length > 0) {
    const errorMsg = `Missing required settings: ${missingSettings.join(", ")}`;
    elizaLogger.error(errorMsg);
    throw new Error(errorMsg);
  }

  elizaLogger.info("Initializing BSC wallet provider...");
  
  // Create BSC wallet provider
  const walletProvider: ExtendedWalletProvider = {
    provider, // Replace connection with provider
    getChain: () => ({ type: "bsc" }),
    getAddress: () => wallet ? wallet.address : walletAddress,
    
    signMessage: async (message: string): Promise<Signature> => {
      if (!wallet) throw new Error("No private key available for signing");
      const signature = await wallet.signMessage(message);
      return { signature, message };
    },
    
    balanceOf: async (tokenAddress: string): Promise<ExtendedBalance> => {
      try {
        const address = wallet ? wallet.address : walletAddress;
        if (!address) throw new Error("No wallet address configured");
        
        // Handle native BNB token
        if (tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
            tokenAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
          const balance = await provider.getBalance(address);
          return {
            value: BigInt(balance.toString()),
            decimals: 18,
            formatted: ethers.utils.formatEther(balance),
            symbol: "BNB",
            name: "BNB Chain",
          };
        } else {
          // Handle BEP-20 tokens
          const tokenAbi = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function name() view returns (string)"
          ];
          
          const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
          const balance = await tokenContract.balanceOf(address);
          const decimals = await tokenContract.decimals();
          const symbol = await tokenContract.symbol();
          const name = await tokenContract.name();
          
          return {
            value: BigInt(balance.toString()),
            decimals,
            formatted: ethers.utils.formatUnits(balance, decimals),
            symbol,
            name,
          };
        }
      } catch (error) {
        elizaLogger.error(`Error fetching balance for ${tokenAddress}:`, error);
        return {
          value: BigInt(0),
          decimals: 18,
          formatted: "0",
          symbol: "BNB",
          name: "BNB Chain",
        };
      }
    },
    
    getMaxBuyAmount: async (tokenAddress: string) => {
      try {
        const address = wallet ? wallet.address : walletAddress;
        if (!address) return 0;
        
        const balance = await provider.getBalance(address);
        // Use 90% of balance for trading to leave room for gas
        return Number(ethers.utils.formatEther(balance)) * 0.9;
      } catch (error) {
        elizaLogger.error(`Failed to get max buy amount for ${tokenAddress}:`, error);
        return 0;
      }
    },
    
    executeTrade: async (params) => {
      if (!wallet) return { success: false, error: "No private key available for trading" };
      
      // In a real implementation, you would connect to PancakeSwap or another DEX
      // This is a placeholder
      elizaLogger.info(`Executing BSC trade with params:`, params);
      
      return { success: true };
    },
    
    getFormattedPortfolio: async () => "",

    async get(runtime, _message, _state) {
      const address = wallet ? wallet.address : walletAddress;
      if (!address) return { text: "No wallet configured", values: {}, data: {} };
      
      // Get BNB balance
      const bnbBalance = await provider.getBalance(address);
      const formattedBalance = ethers.utils.formatEther(bnbBalance);
      
      return {
        text: `Wallet ${address}: ${formattedBalance} BNB`,
        values: { walletBalance: formattedBalance, walletSymbol: "BNB" },
        data: { balance: parseFloat(formattedBalance) },
      };
    },
  };

  elizaLogger.info("BSC wallet provider initialized successfully");

  // Initialize Twitter service if enabled
  let twitterService: TwitterService | undefined;
  try {
    elizaLogger.info("Configuring Twitter service for trade notifications...");
    const twitterConfig = TwitterConfigSchema.parse({
      enabled: getSetting("TWITTER_ENABLED") === "true",
      username: getSetting("TWITTER_USERNAME"),
      dryRun: false,
    });

    if (twitterConfig.enabled && runtime) {
      elizaLogger.info("Starting Twitter client initialization...");
      const twitterClient = await TwitterClientInterface.start(runtime as any);
      twitterService = new TwitterService(twitterClient, twitterConfig);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      elizaLogger.info("Twitter service initialized successfully");
    }
  } catch (error) {
    elizaLogger.error("Failed to initialize Twitter service:", error);
  }

  elizaLogger.info("Initializing plugin components...");

  try {
    const customActions = actions;
    
    // Create trust evaluator and provider for BSC
    const trustEvaluator = {
      name: "BSC Trust Evaluator",
      evaluate: async () => ({ trust: true, score: 0.7 }), // Simplified implementation
    };
    
    const trustScoreProvider = {
      name: "BSC Trust Score Provider",
      get: async () => ({ trust: true, score: 0.7 }), // Simplified implementation
    };

    // Create BSC plugin equivalent
    const bscPlugin = {
      name: "BSC Plugin",
      evaluators: [trustEvaluator],
      providers: [trustScoreProvider],
      actions: [],
    };

    // Create the plugin
    const plugin: ExtendedPlugin = {
      name: "[Rabbi Trader] Onchain Actions with BNB Chain Integration",
      description: "Autonomous trading integration with AI analysis for BNB Chain",
      evaluators: [trustEvaluator, ...(bscPlugin.evaluators || [])],
      providers: [
        walletProvider,
        trustScoreProvider,
        ...(bscPlugin.providers || []),
      ],
      actions: [...customActions, ...(bscPlugin.actions || [])],
      services: [],
      autoStart: true,
    };

    // Add auto-start trading analysis
    if (!runtime) return plugin;

    elizaLogger.info("Starting autonomous trading system...");
    const analyzeTradeAction = plugin.actions.find(
      (a) => a.name === "ANALYZE_TRADE"
    );

    if (!analyzeTradeAction) return plugin;

    const interval = Number(runtime.getSetting("TRADING_INTERVAL")) || 300000;

    // Start trading loop if enabled
    if (!settings.ENABLE_TRADING) return plugin;

    elizaLogger.info("Initializing trading loop...");
    await resumeTrading();
    setInterval(resumeTrading, interval);

    elizaLogger.info("Plugin initialization completed successfully");
    return plugin;
  } catch (error) {
    elizaLogger.error("Failed to initialize plugin components:", error);
    throw new Error(
      `Plugin initialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function analyzeToken(
  runtime: IAgentRuntime,
  provider: ethers.providers.JsonRpcProvider,
  twitterService: TwitterService,
  tokenAddress: string
) {
  try {
    // Check cache first
    const cachedData: CacheEntry | undefined = tokenCache.get(tokenAddress);
    const now = Date.now();

    // Skip if analyzed within last 20 minutes
    if (cachedData && now - cachedData.lastAnalysis < 1200000) {
      elizaLogger.info(
        `Using cached data for ${tokenAddress}, last analyzed ${Math.floor(
          (now - cachedData.lastAnalysis) / 1000
        )}s ago`
      );
      return;
    }

    elizaLogger.info(`Starting analysis for token: ${tokenAddress}`);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!validateBscAddress(tokenAddress)) {
      elizaLogger.error(`Invalid token address format: ${tokenAddress}`);
      return;
    }

    // Initialize TokenProvider with the token address
    const tokenProvider = new TokenProvider(tokenAddress);

    // Get processed token data
    elizaLogger.info(`Fetching token data for ${tokenAddress}`);
    const tokenData = await tokenProvider.getProcessedTokenData();
    elizaLogger.info(`Token data fetched for ${tokenAddress}:`, tokenData);

    // Get trust score and cache it
    const trustProvider = new TrustScoreProvider();
    const trustEvaluation = await trustProvider.evaluateToken(tokenAddress);
    const { trustScore } = trustEvaluation;

    // Cache the new data
    const cacheEntry: CacheEntry = {
      lastAnalysis: Date.now(),
      tokenData,
      trustScore,
      analysisResult: null, // Will be updated after analysis
    };
    tokenCache.set(tokenAddress, cacheEntry);

    // Initialize trustScoreDb
    const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

    // Get the latest trade performance
    const latestTrade = await trustScoreDb.getLatestTradePerformance(
      tokenAddress,
      runtime.agentId,
      false // not simulation
    );

    elizaLogger.info(`Latest trade for ${tokenAddress}:`, latestTrade);

    // Get wallet balance for BSC
    const walletBalance = await getChainWalletBalance(runtime, tokenAddress);

    const pair = tokenData.dexScreenerData.pairs[0];
    const analysisParams: AnalysisParams = {
      walletBalance,
      tokenAddress,
      price: Number(pair?.priceUsd || 0),
      volume: pair?.volume?.h24 || 0,
      marketCap: pair?.marketCap || 0,
      liquidity: pair?.liquidity?.usd || 0,
      holderDistribution: tokenData.holderDistributionTrend,
      trustScore: trustScore || 0,
      dexscreener: tokenData.dexScreenerData,
      position: latestTrade
        ? {
            token_address: latestTrade.token_address,
            entry_price: latestTrade.buy_price,
            size: latestTrade.buy_amount,
            stop_loss: latestTrade.buy_price * 0.85, // 15% stop loss
            take_profit: latestTrade.buy_price * 1.3, // 30% take profit
            open_timeStamp: latestTrade.buy_timeStamp,
            status: latestTrade.sell_timeStamp ? "CLOSED" : "OPEN",
          }
        : undefined,
    };

    // Create initial state
    const state: State = await runtime.composeState({
      userId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: `Initialize state for ${tokenAddress}`,
        type: "analysis",
      },
    });

    // Create analysis memory
    const analysisMemory: Memory = {
      userId: state.userId,
      agentId: runtime.agentId,
      roomId: state.roomId,
      content: {
        text: `Analyze trade for ${tokenAddress}`,
        type: "analysis",
      },
    };

    // Update analysis result in cache after completion
    const analysisResult = await analyzeTradeAction.handler(
      runtime,
      analysisMemory,
      state,
      analysisParams,
      async (response) => {
        if (!response) {
          elizaLogger.error(`Empty response from analysis for ${tokenAddress}`);
          return [];
        }

        elizaLogger.info(`Analysis result for ${tokenAddress}:`, response);
        try {
          // Parse the JSON response from the analysis
          const result =
            typeof response.text === "string"
              ? JSON.parse(response.text)
              : response.text;

          if (!result) {
            elizaLogger.error(`Invalid analysis result for ${tokenAddress}`);
            return [];
          }

          if (result.shouldTrade && result.recommendedAction === "BUY") {
            await buy({
              result,
              runtime,
              state,
              tokenAddress,
              tokenData,
              twitterService,
              trustScore,
              provider,
            });
          } else if (result.recommendedAction === "SELL") {
            await sell({
              latestTrade,
              result,
              runtime,
              state,
              tokenAddress,
              tokenProvider,
              trustScoreDb,
              twitterService,
              trustScore,
              provider,
            });
          } else {
            elizaLogger.info(
              `Trade not recommended for ${tokenAddress}:`,
              result
            );
          }
        } catch (err) {
          elizaLogger.error("rabbi - trade error", err);
        }
        return [];
      }
    );
    cacheEntry.analysisResult = analysisResult;
    tokenCache.set(tokenAddress, cacheEntry);
  } catch (tokenError) {
    elizaLogger.error(`Error processing token ${tokenAddress}:`, {
      error: tokenError,
      stack: tokenError instanceof Error ? tokenError.stack : undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function buy({
  runtime,
  tokenAddress,
  state,
  tokenData,
  result,
  twitterService,
  trustScore,
  provider,
}: {
  runtime: IAgentRuntime;
  tokenAddress: string;
  state: State;
  tokenData: ProcessedTokenData;
  result: any;
  twitterService: TwitterService;
  trustScore: number;
  provider: ethers.providers.JsonRpcProvider;
}) {
  elizaLogger.info(`Trade recommended for ${tokenAddress}:`, result);

  // Continue with simulation if analysis recommends trading
  const simulationService = new SimulationService();
  const simulation = await simulationService.simulateTrade(
    tokenAddress,
    result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE
  );

  if (simulation.recommendedAction === "EXECUTE") {
    try {
      // Check wallet balance before trade
      const currentBalance = await getWalletBalance(runtime);

      const tradeAmount = Math.min(
        result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE,
        currentBalance * 0.95 // Leave some BNB for fees
      );

      if (tradeAmount < SAFETY_LIMITS.MINIMUM_TRADE) {
        elizaLogger.warn(
          `Insufficient balance for trade: ${currentBalance} BNB`
        );
      }

      // Create trade memory object
      const tradeMemory: Memory = {
        userId: state.userId,
        agentId: runtime.agentId,
        roomId: state.roomId,
        content: {
          text: `Execute trade for ${tokenAddress}`,
          tokenAddress,
          amount: SAFETY_LIMITS.MINIMUM_TRADE,
          action: "BUY",
          source: "system",
          type: "trade",
        },
      };

      // Execute trade using our custom function
      const tradeResult = await executeTrade(runtime, {
        tokenAddress,
        amount: tradeAmount,
        slippage: 0.03, // 3% for BSC
        chain: "bsc",
      });

      if (tradeResult.success) {
        elizaLogger.info(`Trade executed successfully for ${tokenAddress}:`, {
          signature: tradeResult.signature,
          amount: tradeAmount,
          memory: tradeMemory,
        });

        // Check rate limit before tweeting
        if (twitterService && result.recommendedAction === "BUY") {
          await tweetTrade(twitterService, {
            token:
              tokenData.dexScreenerData.pairs[0]?.baseToken?.symbol ||
              tokenAddress,
            tokenAddress: tokenAddress,
            amount: tradeAmount,
            trustScore: Number(trustScore) || 0,
            riskLevel: result.riskLevel || "MEDIUM",
            marketData: {
              priceChange24h:
                tokenData.dexScreenerData.pairs[0]?.priceChange?.h24 || 0,
              volume24h: tokenData.dexScreenerData.pairs[0]?.volume?.h24 || 0,
              liquidity: {
                usd: tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
              },
            },
            timestamp: Date.now(),
            signature: tradeResult.signature,
            hash: tradeResult.hash,
            action: "BUY",
            price: Number(tokenData.dexScreenerData.pairs[0]?.priceUsd || 0),
          });
        } else {
          elizaLogger.info("Skipping tweet due to rate limit");
        }

        // Record trade using TrustScoreDatabase methods
        const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

        try {
          elizaLogger.info(
            `Attempting to validate token address: ${tokenAddress}`
          );
          
          // Create a new recommender ID for this trade
          const uuid = uuidv4();
          const recommender = await trustScoreDb.getOrCreateRecommender({
            id: uuid,
            address: runtime.getSetting("BSC_WALLET_ADDRESS") || "",
            solanaPubkey: "", // Empty for BSC
          });
          elizaLogger.info(`Created/retrieved recommender:`, {
            recommender,
            chainType: "bsc",
          });

          // Prepare trade data
          const tradeData = {
            buy_amount: tradeAmount,
            is_simulation: false,
            token_address: tokenAddress,
            buy_price: tokenData.dexScreenerData.pairs[0]?.priceUsd || 0,
            buy_timeStamp: new Date().toISOString(),
            buy_market_cap: tokenData.dexScreenerData.pairs[0]?.marketCap || 0,
            buy_liquidity:
              tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
            buy_value_usd:
              tradeAmount *
              Number(tokenData.dexScreenerData.pairs[0]?.priceUsd || 0),
          };
          elizaLogger.info(`Prepared trade data:`, tradeData);

          // Create trade record directly using trustScoreDb
          await trustScoreDb.addTradePerformance(
            {
              token_address: tokenAddress,
              recommender_id: recommender.id,
              buy_price: Number(tradeData.buy_price),
              buy_timeStamp: tradeData.buy_timeStamp,
              buy_amount: tradeData.buy_amount,
              buy_value_usd: tradeData.buy_value_usd,
              buy_market_cap: tradeData.buy_market_cap,
              buy_liquidity: tradeData.buy_liquidity,
              buy_sol: tradeAmount, // Field name remains for compatibility but contains BNB amount
              last_updated: new Date().toISOString(),
              sell_price: 0,
              sell_timeStamp: "",
              sell_amount: 0,
              received_sol: 0,
              sell_value_usd: 0,
              sell_market_cap: 0,
              sell_liquidity: 0,
              profit_usd: 0,
              profit_percent: 0,
              market_cap_change: 0,
              liquidity_change: 0,
              rapidDump: false,
            },
            false
          );

          elizaLogger.info(
            `Successfully recorded trade performance for ${tokenAddress}`
          );
        } catch (error) {
          elizaLogger.error("Failed to record trade performance:", {
            error,
            tokenAddress,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            errorType: error?.constructor?.name,
          });
        }
      } else {
        elizaLogger.error(
          `Trade execution failed for ${tokenAddress}:`,
          tradeResult.error
        );
      }
    } catch (tradeError) {
      elizaLogger.error(`Error during trade execution for ${tokenAddress}:`, {
        error: tradeError,
        stack: tradeError instanceof Error ? tradeError.stack : undefined,
      });
    }
  } else {
    elizaLogger.info(
      `Simulation rejected trade for ${tokenAddress}:`,
      simulation
    );
  }
}

async function sell({
  state,
  runtime,
  tokenAddress,
  tokenProvider,
  twitterService,
  trustScoreDb,
  latestTrade,
  result,
  trustScore,
  provider,
}: {
  state: State;
  runtime: IAgentRuntime;
  tokenAddress: string;
  tokenProvider: TokenProvider;
  twitterService: TwitterService;
  trustScoreDb: TrustScoreDatabase;
  result: any;
  latestTrade: TradePerformance;
  trustScore: number;
  provider: ethers.providers.JsonRpcProvider;
}) {
  // Get the trade amount from the latest trade
  const tradeAmount = Number(latestTrade?.buy_amount || 0);

  // Execute sell trade
  const tradeResult = await executeTrade(runtime, {
    tokenAddress,
    amount: tradeAmount,
    slippage: 0.03, // 3% for BSC
    chain: "bsc",
  });

  if (tradeResult.success) {
    elizaLogger.info(`Sell executed successfully for ${tokenAddress}:`, {
      signature: tradeResult.signature,
      amount: tradeAmount,
    });

    // Get token data first
    const tokenData = await tokenProvider.getProcessedTokenData();

    // Create recommender
    const uuid = uuidv4();
    const recommender = await trustScoreDb.getOrCreateRecommender({
      id: uuid,
      address: runtime.getSetting("BSC_WALLET_ADDRESS") || "",
      solanaPubkey: "", // Empty for BSC
    });

    // Update sell details and get prices
    const { sellDetails, currentPrice } = await updateSellDetails(
      runtime,
      tokenAddress,
      recommender.id,
      tradeAmount,
      latestTrade,
      tokenData
    );

    // Post tweet if enabled
    if (twitterService) {
      await tweetTrade(twitterService, {
        token:
          tokenData.dexScreenerData.pairs[0]?.baseToken?.symbol || tokenAddress,
        tokenAddress: tokenAddress,
        amount: tradeAmount,
        trustScore: Number(trustScore) || 0,
        riskLevel: result.riskLevel || "MEDIUM",
        marketData: {
          priceChange24h:
            tokenData.dexScreenerData.pairs[0]?.priceChange?.h24 || 0,
          volume24h: tokenData.dexScreenerData.pairs[0]?.volume?.h24 || 0,
          liquidity: {
            usd: tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
          },
        },
        timestamp: Date.now(),
        signature: tradeResult.signature,
        hash: tradeResult.hash,
        action: "SELL",
        price: Number(currentPrice),
        profitPercent: `${sellDetails.profit_percent.toFixed(2)}%`,
        profitUsd: `${sellDetails.profit_usd.toFixed(4)} USD`,
        reason: `P/L: ${sellDetails.profit_percent.toFixed(2)}%`,
      });
    }

    elizaLogger.info(`Successfully updated sell details for ${tokenAddress}`, {
      sellPrice: currentPrice,
      sellAmount: tradeAmount,
    });
  } else {
    elizaLogger.error(
      `Sell execution failed for ${tokenAddress}:`,
      tradeResult.error
    );
  }
}

export default createRabbiTraderPlugin;