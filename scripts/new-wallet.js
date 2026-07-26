/**
 * Generate a FRESH test mnemonic for Sepolia and print the five derived role
 * accounts. Run it yourself and paste the mnemonic into .env — never commit
 * it, and never use a mnemonic that holds real funds.
 *
 *   npx hardhat run scripts/new-wallet.js
 */
const { ethers } = require("hardhat");

const ROLES = ["admin/regulator (deployer — fund this one)", "manufacturer", "distributor", "pharmacy", "oracle node"];

async function main() {
  const wallet = ethers.HDNodeWallet.createRandom();
  const phrase = wallet.mnemonic.phrase;

  console.log("\nNew TEST mnemonic (put this in .env as MNEMONIC=…):\n");
  console.log(`  ${phrase}\n`);
  console.log("Derived role accounts (path m/44'/60'/0'/0/i):\n");
  const mnemonic = ethers.Mnemonic.fromPhrase(phrase);
  for (let i = 0; i < 5; i++) {
    const child = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`);
    console.log(`  [${i}] ${child.address}  ${ROLES[i]}`);
  }
  console.log("\nNext steps:");
  console.log("  1. Fund account [0] from a Sepolia faucet (e.g. https://sepoliafaucet.com)");
  console.log("  2. npx hardhat run scripts/fund-accounts.js --network sepolia");
  console.log("  3. npx hardhat run scripts/deploy.js --network sepolia\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
