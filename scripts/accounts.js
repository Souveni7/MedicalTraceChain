/**
 * Print the five role accounts for the selected network, with balances.
 * Never prints the mnemonic itself.
 *
 *   npx hardhat run scripts/accounts.js --network sepolia
 */
const hre = require("hardhat");
const { getRoleSigners, banner } = require("./helpers");

const LABELS = [
  ["admin/regulator (deployer — fund this one)", "admin"],
  ["manufacturer", "manufacturer"],
  ["distributor", "distributor"],
  ["pharmacy", "pharmacy"],
  ["oracle node", "oracle"],
];

async function main() {
  const roles = await getRoleSigners();
  const order = [roles.admin, roles.manufacturer, roles.distributor, roles.pharmacy, roles.oracle];

  banner(`Role accounts on ${hre.network.name}`);
  for (let i = 0; i < order.length; i++) {
    const balance = await hre.ethers.provider.getBalance(order[i].address);
    console.log(
      `   [${i}] ${order[i].address}  ${hre.ethers.formatEther(balance).padStart(10)} ETH  ${LABELS[i][0]}`
    );
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
