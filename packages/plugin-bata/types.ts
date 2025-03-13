// 交易动作输入内容的接口定义
export interface TradeActionContent {
    baseAsset: string;   // 要交易的基础资产（例如 "BNB" 或其合约地址）
    quoteAsset: string;  // 报价资产或计价资产（例如 "BUSD" 或 "USDT" 的合约地址）
    amount: string;      // 交易数量，以字符串表示（避免精度问题，可以使用Big.js等库处理）
    // 可以扩展更多参数，如止损价、滑点容忍度等
  }
  
  // 交易决策类型：买入、卖出或观望
  export type TradeDecision = "BUY" | "SELL" | "HOLD";
  
  // 价格数据类型
  export interface PriceData {
    price: number;      // 当前价格，如 baseAsset 相对于 quoteAsset 的价格
    timestamp: number;  // 时间戳（秒）
  }
  