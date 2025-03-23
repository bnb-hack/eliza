import {
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type State,
  type Provider
} from "@elizaos/core";

import { connectWallet, getWalletBalance as rabbiGetBalance, signTransaction } from "rabbi-trader";
import { ethers } from "ethers";
import { BNB_CONFIG, ZEROEX_CONFIG } from "./config";
import { SAFETY_LIMITS } from "./constants";

// --- Local wallet logic ---

export function getWalletKeypair(runtime: IAgentRuntime): ethers.Wallet {
  const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("No BNB wallet private key configured");
  }
  const pk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  const provider = new ethers.providers.JsonRpcProvider(BNB_CONFIG.RPC_URL);
  return new ethers.Wallet(pk, provider);
}

export async function getLocalWalletBalance(runtime: IAgentRuntime): Promise<number> {
  try {
    const wallet = getWalletKeypair(runtime);
    const balanceWei = await wallet.provider.getBalance(wallet.address);
    const balanceBNB = Number(ethers.utils.formatEther(balanceWei));
    elizaLogger.log("Fetched BNB wallet balance (local):", {
      address: wallet.address,
      bnb: balanceBNB,
    });
    return balanceBNB;
  } catch (error) {
    elizaLogger.error("Failed to get local wallet balance:", error);
    return 0;
  }
}

export async function executeTrade(
  runtime: IAgentRuntime,
  params: { tokenAddress: string; amount: number; slippage: number; isSell?: boolean }
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const { tokenAddress, amount, slippage, isSell } = params;
  elizaLogger.log("Executing trade with params:", params);

  if (!isSell && amount < SAFETY_LIMITS.MINIMUM_TRADE) {
    elizaLogger.warn("Trade amount too small:", {
      amount,
      minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
    });
    return { success: false, error: "Trade amount below minimum" };
  }

  try {
    const wallet = getWalletKeypair(runtime);
    const sellToken = isSell ? tokenAddress : "BNB";
    const buyToken = isSell ? "BNB" : tokenAddress;
    const sellAmountWei = sellToken === "BNB"
      ? ethers.utils.parseEther(amount.toString()).toString()
      : ethers.utils.parseUnits(amount.toString(), 18).toString();

    const quoteUrl = `${ZEROEX_CONFIG.API_URL}${ZEROEX_CONFIG.QUOTE_ENDPOINT}?` +
      `sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmountWei}` +
      `&slippagePercentage=${slippage}&chainId=${ZEROEX_CONFIG.SUPPORTED_CHAINS.BSC}`;

    elizaLogger.log("Requesting 0x swap quote:", quoteUrl);
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      elizaLogger.warn("0x quote request failed:", {
        status: quoteRes.status,
        error: errText,
      });
      return { success: false, error: `0x quote failed: ${errText}` };
    }

    const quoteData = await quoteRes.json();
    if (!quoteData || !quoteData.to || !quoteData.data) {
      elizaLogger.warn("Invalid 0x quote data:", quoteData);
      return { success: false, error: "Invalid quote data from 0x" };
    }

    elizaLogger.log("0x quote received:", {
      price: quoteData.price,
      guaranteedPrice: quoteData.guaranteedPrice,
      estimatedGas: quoteData.estimatedGas,
    });

    const txRequest: ethers.providers.TransactionRequest = {
      to: quoteData.to,
      data: quoteData.data,
      value: quoteData.value ? ethers.BigNumber.from(quoteData.value) : ethers.constants.Zero,
      gasLimit: quoteData.gas || quoteData.estimatedGas || ethers.utils.hexlify(300000),
      gasPrice: quoteData.gasPrice ? ethers.BigNumber.from(quoteData.gasPrice) : undefined,
    };

    const txResponse = await wallet.sendTransaction(txRequest);
    elizaLogger.log("Transaction sent:", txResponse.hash);
    const receipt = await txResponse.wait();

    if (receipt.status !== 1) {
      throw new Error(`Transaction failed on-chain: ${receipt.status}`);
    }

    elizaLogger.log("Trade executed successfully:", {
      hash: txResponse.hash,
      explorer: `https://bscscan.com/tx/${txResponse.hash}`,
    });

    return { success: true, hash: txResponse.hash };
  } catch (error: any) {
    elizaLogger.error("Trade execution failed:", {
      error: error.message || error,
      stack: error.stack,
    });
    return { success: false, error: error.message || String(error) };
  }
}

// --- Eliza Wallet Provider: supports rabbi-trader or local ---

export const walletProvider: Provider = {
  name: "wallet",

  get: async (runtime: IAgentRuntime, _msg: Memory, state?: State): Promise<string | null> => {
    const useRabbi = runtime.getSetting("USE_RABBI_WALLET") === "true";

    try {
      if (useRabbi) {
        const wallet = await connectWallet();
        const address = wallet.getAddress();
        const balance = await rabbiGetBalance(address);
        const chain = wallet.getChain();

        return `${state?.agentName || "The agent"}'s Rabbi Wallet:\n` +
          `Address: ${address}\nBalance: ${balance} ${chain.nativeCurrency.symbol}\n` +
          `Chain: ${chain.name} (ID: ${chain.id})`;
      } else {
        const wallet = getWalletKeypair(runtime);
        const balance = await getLocalWalletBalance(runtime);

        return `${state?.agentName || "The agent"}'s Local Wallet:\n` +
          `Address: ${wallet.address}\nBalance: ${balance} BNB`;
      }
    } catch (err) {
      elizaLogger.error("walletProvider.get failed:", err);
      return null;
    }
  },

  set: async (runtime: IAgentRuntime, _msg: Memory, _state: State, params: any) => {
    const useRabbi = runtime.getSetting("USE_RABBI_WALLET") === "true";

    try {
      if (useRabbi) {
        const sellAmountWei = params.tokenAddress === "BNB"
          ? ethers.utils.parseEther(params.amount.toString()).toString()
          : ethers.utils.parseUnits(params.amount.toString(), 18).toString();

        const quoteUrl = `${ZEROEX_CONFIG.API_URL}${ZEROEX_CONFIG.QUOTE_ENDPOINT}?` +
          `sellToken=${params.isSell ? params.tokenAddress : "BNB"}` +
          `&buyToken=${params.isSell ? "BNB" : params.tokenAddress}` +
          `&sellAmount=${sellAmountWei}&slippagePercentage=${params.slippage}` +
          `&chainId=${ZEROEX_CONFIG.SUPPORTED_CHAINS.BSC}`;

        const res = await fetch(quoteUrl);
        if (!res.ok) {
          const errText = await res.text();
          return `❌ Rabbi quote failed: ${errText}`;
        }

        const data = await res.json();
        const txRequest: ethers.providers.TransactionRequest = {
          to: data.to,
          data: data.data,
          value: data.value ? ethers.BigNumber.from(data.value) : ethers.constants.Zero,
          gasLimit: data.gas || data.estimatedGas || ethers.utils.hexlify(300000),
          gasPrice: data.gasPrice ? ethers.BigNumber.from(data.gasPrice) : undefined,
        };

        const tx = await signTransaction(txRequest);
        return `✅ Rabbi trade executed! TX: ${tx.hash}`;
      } else {
        const result = await executeTrade(runtime, params);
        return result.success
          ? `✅ Local trade executed! TX: ${result.hash}`
          : `❌ Trade failed: ${result.error}`;
      }
    } catch (err: any) {
      elizaLogger.error("walletProvider.set failed:", err);
      return `❌ Error: ${err.message || err}`;
    }
  }
};