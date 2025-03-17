import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { ethers } from "ethers";
import { BNB_CONFIG, ZEROEX_CONFIG } from "./config";
import { SAFETY_LIMITS } from "./constants";

/**
 * getWalletKeypair returns an ethers Wallet instance using the BNB_PRIVATE_KEY from settings.
 */
export function getWalletKeypair(runtime: IAgentRuntime): ethers.Wallet {
  const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("No BNB wallet private key configured");
  }
  const pk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  const provider = new ethers.providers.JsonRpcProvider(BNB_CONFIG.RPC_URL);
  return new ethers.Wallet(pk, provider);
}

/**
 * getWalletBalance returns the wallet balance in BNB.
 */
export async function getWalletBalance(runtime: IAgentRuntime): Promise<number> {
  try {
    const wallet = getWalletKeypair(runtime);
    const balanceWei = await wallet.provider.getBalance(wallet.address);
    const balanceBNB = Number(ethers.utils.formatEther(balanceWei));
    elizaLogger.log("Fetched BNB wallet balance:", { address: wallet.address, bnb: balanceBNB });
    return balanceBNB;
  } catch (error) {
    elizaLogger.error("Failed to get BNB wallet balance:", error);
    return 0;
  }
}

/**
 * executeTrade uses the 0x Swap API (as exposed by plugin-bnb) to perform a swap.
 */
export async function executeTrade(
  runtime: IAgentRuntime,
  params: { tokenAddress: string; amount: number; slippage: number; isSell?: boolean }
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const { tokenAddress, amount, slippage, isSell } = params;
  elizaLogger.log("Executing trade with params:", params);
  if (!isSell && amount < SAFETY_LIMITS.MINIMUM_TRADE) {
    elizaLogger.warn("Trade amount too small:", { amount, minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE });
    return { success: false, error: "Trade amount below minimum" };
  }
  try {
    const wallet = getWalletKeypair(runtime);
    const sellToken = isSell ? tokenAddress : "BNB";
    const buyToken = isSell ? "BNB" : tokenAddress;
    let sellAmountWei: string;
    if (sellToken === "BNB") {
      sellAmountWei = ethers.utils.parseEther(amount.toString()).toString();
    } else {
      sellAmountWei = ethers.utils.parseUnits(amount.toString(), 18).toString();
    }
    const chainIdParam = ZEROEX_CONFIG.SUPPORTED_CHAINS.BSC;
    const quoteUrl = `${ZEROEX_CONFIG.API_URL}${ZEROEX_CONFIG.QUOTE_ENDPOINT}?` +
      `sellToken=${sellToken === "BNB" ? "BNB" : tokenAddress}&buyToken=${buyToken === "BNB" ? "BNB" : tokenAddress}` +
      `&sellAmount=${sellAmountWei}&slippagePercentage=${slippage}&chainId=${chainIdParam}`;
    elizaLogger.log("Requesting 0x swap quote:", quoteUrl);
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      elizaLogger.warn("0x quote request failed:", { status: quoteRes.status, error: errText });
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
