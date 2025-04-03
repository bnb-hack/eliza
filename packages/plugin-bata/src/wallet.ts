import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { ethers } from "ethers";
import { SAFETY_LIMITS } from "./constants";

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Ethereum wallet instance
 * @throws Error if private key is missing or invalid
 */
export function getWallet(runtime?: IAgentRuntime): ethers.Wallet {
    const privateKeyString = runtime?.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    try {
        return new ethers.Wallet(privateKeyString);
    } catch (error) {
        elizaLogger.error("Failed to create wallet:", error);
        throw error;
    }
}

/**
 * Gets current ETH balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in ETH
 */
export async function getWalletBalance(
    runtime: IAgentRuntime
): Promise<number> {
    try {
        const wallet = getWallet(runtime);
        const provider = new ethers.providers.JsonRpcProvider(
            runtime.getSetting("BASE_RPC_URL") || "YOUR_BASE_RPC_URL"
        );

        const balance = await provider.getBalance(wallet.address);
        const ethBalance = parseFloat(ethers.utils.formatEther(balance));

        elizaLogger.log("Fetched Base wallet balance:", {
            address: wallet.address,
            wei: balance.toString(),
            eth: ethBalance,
        });

        return ethBalance;
    } catch (error) {
        elizaLogger.error("Failed to get wallet balance:", error);
        return 0;
    }
}

// Add executeTrade function
export async function executeTrade(
    runtime: IAgentRuntime,
    params: {
        tokenAddress: string;
        amount: number;
        slippage: number;
        isSell?: boolean;
        chain?: "base" | "solana";
    },
    retryCount = 0
): Promise<any> {
    try {
        elizaLogger.log("Executing Base trade with params:", params);

        const wallet = getWallet(runtime);
        const provider = new ethers.providers.JsonRpcProvider(
            runtime.getSetting("BASE_RPC_URL") || "YOUR_BASE_RPC_URL"
        );
        const dexAddress = runtime.getSetting("DEX_CONTRACT_ADDRESS"); // 需要设置dex的地址

        if (!dexAddress) {
            throw new Error("DEX contract address not configured");
        }

        if (!params.isSell && params.amount < SAFETY_LIMITS.MINIMUM_TRADE) {
            elizaLogger.warn("Trade amount too small:", {
                amount: params.amount,
                minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
            });
            return {
                success: false,
                error: "Trade amount too small",
                details: {
                    amount: params.amount,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
                },
            };
        }

        const dexContract = new ethers.Contract(
            dexAddress,
            [
                "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
                "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
            ],
            wallet.connect(provider)
        );

        const amountIn = ethers.utils.parseEther(params.amount.toString());
        const amountOutMin = ethers.utils.parseEther((params.amount * (1 - params.slippage)).toString());
        const path = params.isSell
            ? [params.tokenAddress, "YOUR_WETH_ADDRESS"] // 替换为weth地址
            : ["YOUR_WETH_ADDRESS", params.tokenAddress]; // 替换为weth地址
        const to = wallet.address;
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

        let transaction;
        if (params.isSell) {
            transaction = await dexContract.swapExactTokensForETH(
                amountIn,
                amountOutMin,
                path,
                to,
                deadline
            );
        } else {
            transaction = await dexContract.swapExactETHForTokens(
                amountOutMin,
                path,
                to,
                deadline,
                { value: amountIn }
            );
        }

        const receipt = await transaction.wait();

        elizaLogger.log("Base trade executed successfully:", {
            transactionHash: receipt.transactionHash,
            explorer: `https://basescan.org/tx/${receipt.transactionHash}`,
        });

        return {
            success: true,
            receipt,
            explorer: `https://basescan.org/tx/${receipt.transactionHash}`,
        };
    } catch (error) {
        if (retryCount < 3) {
            elizaLogger.warn(
                `Transaction error, retrying (${retryCount + 1}/3)...`
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return executeTrade(runtime, params, retryCount + 1);
        }

        elizaLogger.error("Trade execution failed:", {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            params,
            retryCount,
        });

        return {
            success: false,
            error: error.message || error,
            params,
            stack: error instanceof Error ? error.stack : undefined,
        };
    }
}

export async function getChainWalletBalance(
    runtime: IAgentRuntime,
    _tokenAddress: string
): Promise<number> {
    // Get Base balance
    return await getWalletBalance(runtime);
}

// Add this helper function at the top level
export async function simulateTransaction(
    client: any,
    tx: any
): Promise<string> {
    try {
        const result = await client.call({
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
        });
        return result;
    } catch (error) {
        return `Simulation failed: ${error.message}`;
    }
}