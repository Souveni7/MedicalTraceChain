/**
 * Sepolia helper — tops up the four role accounts (manufacturer, distributor,
 * pharmacy, oracle) from the funded admin account so they can pay gas.
 *
 *   npx hardhat run scripts/fund-accounts.js --network sepolia
 */
const hre = require("hardhat");
const { getRoleSigners, banner, short } = require("./helpers");

// Sepolia gas is ~1-2 gwei, so 0.008 ETH covers dozens of demo txs per role;
// one 0.05 ETH faucet claim is enough for the whole account layout.
const TOP_UP = hre.ethers.parseEther("0.008");
const MIN_BALANCE = hre.ethers.parseEther("0.004");

async function main() {
  const { admin, manufacturer, distributor, pharmacy, oracle } =
    await getRoleSigners();

  banner(`Funding role accounts on ${hre.network.name}`);
  const adminBalance = await hre.ethers.provider.getBalance(admin.address);
  console.log(`   admin ${short(admin.address)} balance: ${hre.ethers.formatEther(adminBalance)} ETH`);
  if (adminBalance < hre.ethers.parseEther("0.045")) {
    console.warn("   ⚠ admin balance is low — get test ETH from a Sepolia faucet first");
  }

  const targets = [
    ["manufacturer", manufacturer],
    ["distributor", distributor],
    ["pharmacy", pharmacy],
    ["oracle", oracle],
  ];
  for (const [label, signer] of targets) {
    const balance = await hre.ethers.provider.getBalance(signer.address);
    if (balance >= MIN_BALANCE) {
      console.log(`   ${label.padEnd(12)} ${short(signer.address)} already has ${hre.ethers.formatEther(balance)} ETH — skipped`);
      continue;
    }
    const tx = await admin.sendTransaction({ to: signer.address, value: TOP_UP });
    await tx.wait();
    console.log(`   ${label.padEnd(12)} ${short(signer.address)} topped up with ${hre.ethers.formatEther(TOP_UP)} ETH (tx ${tx.hash})`);
  }

  banner("Funding complete");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
