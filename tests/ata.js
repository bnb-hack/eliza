// ata.js
require('dotenv').config();
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');

async function main() {
  try {
    const walletKey = process.env.SOLANA_PUBLIC_KEY?.trim();
    const mintKey   = process.env.SOLANA_VERIFY_TOKEN?.trim();
    const wallet = new PublicKey(walletKey);
    const mint = new PublicKey(mintKey);

  } catch {
    console.error("Invalid Base58 address — check your .env values");
    process.exit(1);
  }
  
  try {
    const ata    = await getAssociatedTokenAddress(mint, wallet);
    console.log('Your ATA address is:', ata.toBase58());
  } catch (err) {
    console.error('Failed to derive ATA:', err);
    process.exit(1);
  }
}

main();
