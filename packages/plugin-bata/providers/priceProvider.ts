import { Provider, IAgentRuntime, Memory } from "@elizaos/core";
import { providers } from "ethers";  // 使用 Ethers.js 提供的Provider
import { PriceData } from "../types";

export const priceProvider: Provider = {
  // Provider 不需要名字，主要通过 get 方法提供数据
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<PriceData | null> => {
    try {
      // 使用 BNB Chain RPC Provider（可以是公开RPC或从配置获取）
      const rpcUrl = process.env.BSC_RPC_URL || "<YOUR_BSC_RPC_URL>";
      const provider = new providers.JsonRpcProvider(rpcUrl);
      // Chainlink BNB/USD 价格馈送合约地址 (主网)
      const feedAddress = "0x0567F2323251f0AaB15c8DfB1967e4e8A7D42aeE";  // Chainlink BNB/USD
      // 根据Chainlink Aggregator V3接口获取最新价格
      const aggregatorV3InterfaceABI = [
        // 只需要latestRoundData函数的ABI
        {"inputs":[],"name":"latestRoundData","outputs":[
          {"internalType":"uint80","name":"roundId","type":"uint80"},
          {"internalType":"int256","name":"answer","type":"int256"},
          {"internalType":"uint256","name":"startedAt","type":"uint256"},
          {"internalType":"uint256","name":"updatedAt","type":"uint256"},
          {"internalType":"uint80","name":"answeredInRound","type":"uint80"}],
         "stateMutability":"view","type":"function"}
      ];
      const priceFeed = new providers.Contract(feedAddress, aggregatorV3InterfaceABI, provider);
      const roundData = await priceFeed.latestRoundData();
      const decimals = 8; // BNB/USD feed has 8 decimals (Chainlink feeds通常有固定小数位)
      const price = Number(roundData.answer) / (10 ** decimals);
      const timestamp = roundData.updatedAt.toNumber();
      return { price, timestamp };
    } catch (err) {
      console.error("获取Chainlink价格失败: ", err);
      return null;
    }
  }
};
