import { IAgentRuntime, Memory, Action } from "@elizaos/core";
import { priceProvider } from "../providers/priceProvider";
import { TradeActionContent, TradeDecision } from "../types";

export const tradeAction: Action = {
  name: "ADAPTIVE_TRADE",
  description: "基于价格波动的自适应交易动作，在BNB Chain上自动买卖资产",
  // similes 可以定义同义动作名称
  similes: ["AUTO_TRADE", "TRADE_TOKEN"],
  // 验证函数：可根据需要验证输入的内容，例如检查交易参数完整性
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const content = message.content as TradeActionContent;
    if (!content || !content.baseAsset || !content.quoteAsset || !content.amount) {
      // 若内容不完整，则验证失败
      return false;
    }
    return true;
  },
  // 核心处理函数：执行交易逻辑
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const content = message.content as TradeActionContent;
    const { baseAsset, quoteAsset, amount } = content;
    // 1. 获取当前价格（通过 Chainlink 提供的价格数据）
    const priceData = await priceProvider.get(runtime, message);
    if (!priceData) {
      throw new Error("无法获取价格数据");
    }
    const currentPrice = priceData.price;  // 假设 priceProvider 返回 { price: number, timestamp: number }
    // 2. 计算价格波动（与上次价格比较）
    let lastPrice = runtime.getState("lastPrice");  // 从 Agent 运行时或插件状态获取上次价格
    if (!lastPrice) {
      // 如果没有上次价格记录，则先保存当前价后返回，不进行交易
      runtime.setState("lastPrice", currentPrice);
      return `当前价格为 ${currentPrice}（首次记录价格，未执行交易）`;
    }
    const priceChange = (currentPrice - lastPrice) / lastPrice;
    // 3. 决定交易方向（简单策略：涨超阈值则卖，跌超阈值则买）
    const threshold = 0.01; // 1% 阈值，可根据策略调整
    let decision: TradeDecision = "HOLD";
    if (priceChange > threshold) {
      decision = "SELL";  // 价格上涨超过阈值，卖出 baseAsset 换 quoteAsset
    } else if (priceChange < -threshold) {
      decision = "BUY";   // 价格下跌超过阈值，买入 baseAsset（花费 quoteAsset）
    }
    // 4. （可选）使用 AI 模型辅助决策
    if (runtime.hasCapability("llm") && decision !== "HOLD") {
      // 如果集成了LLM，如OpenAI或Llama，则可询问模型当前市场趋势建议
      const trendAnalysisPrompt = `当前${baseAsset}价格为${currentPrice}（上次价格为${lastPrice}），变化率${(priceChange*100).toFixed(2)}%。应采取何种交易行动（买入/卖出/观望）？请给出理由。`;
      const aiAdvice = await runtime.generate(trendAnalysisPrompt);
      // （假设 aiAdvice 能返回诸如 "建议买入" 或 "建议卖出" 之类的结论）
      if (aiAdvice.includes("买入") && decision === "SELL") {
        // AI 建议与原决策相反，这里简单示例：如果AI建议买入，但策略想卖，则改为观望
        decision = "HOLD";
      }
      // 实际应用中可更智能地融合 AI 建议，这里仅作示意
    }
    // 5. 执行交易操作（通过 Web3，与链上合约交互）
    let txHash: string | null = null;
    if (decision === "BUY" || decision === "SELL") {
      try {
        // 使用 Web3 提供的 provider 和用户私钥执行交易
        const web3 = runtime.getWeb3Provider("BNB_CHAIN"); 
        const traderAccount = web3.getSigner();  // 获取签名账号（假设runtime已经用私钥配置了Signer）
        // 根据决策构建交易调用，比如调用去中心化交易所合约进行 swap
        if (decision === "BUY") {
          // 示例：调用 PancakeSwap Router 合约用 quoteAsset 换入 baseAsset
          txHash = await executeSwap(web3, traderAccount, quoteAsset, baseAsset, amount);
        } else if (decision === "SELL") {
          // 示例：调用 PancakeSwap Router 合约用 baseAsset 换出 quoteAsset
          txHash = await executeSwap(web3, traderAccount, baseAsset, quoteAsset, amount);
        }
      } catch (error) {
        console.error("交易执行失败：", error);
        return `交易执行失败: ${error}`;
      }
    }
    // 更新最后价格
    runtime.setState("lastPrice", currentPrice);
    // 返回执行结果信息，可用于 Agent 回复用户
    if (decision === "BUY") {
      return `价格下跌${(Math.abs(priceChange)*100).toFixed(2)}%，已买入 ${amount} ${baseAsset} ✅（交易哈希: ${txHash}）`;
    } else if (decision === "SELL") {
      return `价格上涨${(Math.abs(priceChange)*100).toFixed(2)}%，已卖出 ${amount} ${baseAsset} ✅（交易哈希: ${txHash}）`;
    } else {
      return `价格变动为 ${(priceChange*100).toFixed(2)}%，无显著波动，保持持仓。`;
    }
  },
  examples: [
    {
      input: "请帮我根据市场波动自动交易BNB",
      output: "价格下跌2.5%，已买入 1.0 BNB ✅（交易哈希: 0x...）"
    }
  ]
};

// 一个辅助函数示例：与去中心化交易协议交互执行交换
async function executeSwap(web3Provider: any, signer: any, sellToken: string, buyToken: string, amount: string): Promise<string> {
  // 此处为伪代码，展示如何调用链上合约执行 swap，可以集成 PancakeSwap 等DEX的Router合约
  const routerAddress = "0x...PancakeSwapRouter";  // PancakeSwap主网Router地址
  const routerABI = [ /* PancakeSwap Router所需的ABI片段 */ ];
  const router = new web3Provider.Contract(routerAddress, routerABI, signer);
  // 假设我们有 sellToken 和 buyToken 的地址，以及 amount 数量（注意精度换算）
  const tx = await router.swapExactTokensForTokens(
    amount,
    0, // 最小接受量，0表示不做下限控制（生产环境应设定滑点）
    [sellToken, buyToken],
    await signer.getAddress(),
    Math.floor(Date.now()/1000) + 60 // 交易截止时间
  );
  const receipt = await tx.wait();
  return receipt.transactionHash;
}
