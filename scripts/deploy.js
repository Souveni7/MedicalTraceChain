/**
 * Deploys BatchRegistry + ColdChainMonitor and wires up all roles:
 *
 *   account 0 → admin + regulator (deployer)
 *   account 1 → manufacturer      account 3 → pharmacy
 *   account 2 → distributor       account 4 → oracle node
 *   ColdChainMonitor contract     → MONITOR_ROLE on the registry
 *
 * Writes deployments/<network>.json (used by every other script) and, for
 * public networks, addresses.txt (required in the course submission).
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const {
  getRoleSigners,
  saveDeployment,
  banner,
  step,
  short,
} = require("./helpers");

async function main() {
  const { admin, manufacturer, distributor, pharmacy, oracle } =
    await getRoleSigners();

  banner(`Deploying pharma-chain to network: ${hre.network.name}`);
  console.log(`   admin/regulator : ${admin.address}`);
  console.log(`   manufacturer    : ${manufacturer.address}`);
  console.log(`   distributor     : ${distributor.address}`);
  console.log(`   pharmacy        : ${pharmacy.address}`);
  console.log(`   oracle node     : ${oracle.address}`);

  step("Deploying BatchRegistry…");
  const registry = await hre.ethers.deployContract("BatchRegistry", [
    admin.address,
  ]);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  const deployBlock = registry.deploymentTransaction().blockNumber;
  console.log(`   BatchRegistry    → ${registryAddress}`);

  step("Deploying ColdChainMonitor…");
  const monitor = await hre.ethers.deployContract("ColdChainMonitor", [
    registryAddress,
    admin.address,
  ]);
  await monitor.waitForDeployment();
  const monitorAddress = await monitor.getAddress();
  console.log(`   ColdChainMonitor → ${monitorAddress}`);

  step("Granting supply-chain roles (permissioned-network membership)…");
  const grants = [
    [registry, "MANUFACTURER_ROLE", manufacturer.address, "manufacturer"],
    [registry, "DISTRIBUTOR_ROLE", distributor.address, "distributor"],
    [registry, "PHARMACY_ROLE", pharmacy.address, "pharmacy"],
    [registry, "MONITOR_ROLE", monitorAddress, "ColdChainMonitor contract"],
    [monitor, "ORACLE_ROLE", oracle.address, "oracle node"],
  ];
  for (const [contract, roleName, grantee, label] of grants) {
    const role = await contract[roleName]();
    const tx = await contract.connect(admin).grantRole(role, grantee);
    await tx.wait();
    console.log(`   ${roleName.padEnd(18)} → ${label} (${short(grantee)})`);
  }

  const record = {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployBlock,
    contracts: {
      BatchRegistry: registryAddress,
      ColdChainMonitor: monitorAddress,
    },
    accounts: {
      "admin/regulator": admin.address,
      manufacturer: manufacturer.address,
      distributor: distributor.address,
      pharmacy: pharmacy.address,
      oracle: oracle.address,
    },
  };
  const file = saveDeployment(record);
  step(`Deployment record written to ${file}`);

  // addresses.txt is a course submission requirement — only meaningful for a
  // real (persistent) network, so skip it for throwaway local chains.
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    const addressesFile = path.join(__dirname, "..", "addresses.txt");
    fs.writeFileSync(
      addressesFile,
      [
        `COMP6452 Project 2 Task 3 - deployed smart contract addresses`,
        ``,
        `Network:          ${hre.network.name} (chainId ${record.chainId})`,
        `Deployed at:      ${record.deployedAt}`,
        ``,
        `BatchRegistry:    ${registryAddress}`,
        `ColdChainMonitor: ${monitorAddress}`,
        ``,
        `Etherscan:`,
        `  https://sepolia.etherscan.io/address/${registryAddress}`,
        `  https://sepolia.etherscan.io/address/${monitorAddress}`,
        ``,
      ].join("\n")
    );
    step(`addresses.txt written to ${addressesFile}`);
  }

  banner("Deployment complete");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
