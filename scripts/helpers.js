/**
 * Shared helpers for the deployment/demo scripts. All demo output funnels
 * through here so every step prints the same "who did what, which tx, what
 * changed on-chain" shape — the demo is assessed on how clearly component
 * communication is shown.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");

const ROLE_NAMES = ["admin", "manufacturer", "distributor", "pharmacy", "oracle"];

function deploymentFile(networkName) {
  return path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
}

function loadDeployment() {
  const file = deploymentFile(hre.network.name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found for network "${hre.network.name}". ` +
        `Run: npx hardhat run scripts/deploy.js --network ${hre.network.name}`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveDeployment(record) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentFile(hre.network.name);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/** The five demo accounts, by supply-chain role. Account 0 doubles as the
 *  regulator, mirroring the deploy script's role grants. */
async function getRoleSigners() {
  const signers = await hre.ethers.getSigners();
  if (signers.length < 5) {
    throw new Error(
      "Need 5 accounts (admin, manufacturer, distributor, pharmacy, oracle). " +
        "On Sepolia, set MNEMONIC in .env — 5 accounts are derived from it."
    );
  }
  const [admin, manufacturer, distributor, pharmacy, oracle] = signers;
  return { admin, regulator: admin, manufacturer, distributor, pharmacy, oracle };
}

async function getContracts() {
  const dep = loadDeployment();
  const registry = await hre.ethers.getContractAt(
    "BatchRegistry",
    dep.contracts.BatchRegistry
  );
  const monitor = await hre.ethers.getContractAt(
    "ColdChainMonitor",
    dep.contracts.ColdChainMonitor
  );
  return { registry, monitor, dep };
}

/** Map an address to a human label using the deployment record. */
function labelFor(dep, address) {
  const found = Object.entries(dep.accounts || {}).find(
    ([, addr]) => addr.toLowerCase() === address.toLowerCase()
  );
  return found ? `${found[0]} (${short(address)})` : short(address);
}

function short(address) {
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

function banner(title) {
  const line = "=".repeat(64);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function step(text) {
  console.log(`\n▶ ${text}`);
}

/** Send a tx, print its hash, wait for it, print the mined block + events. */
async function sendTx(description, txPromise, contracts = []) {
  step(description);
  const tx = await txPromise;
  console.log(`   tx hash : ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   mined   : block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);
  printEvents(receipt, contracts);
  return receipt;
}

/** Decode and print every event in a receipt that any given contract knows. */
function printEvents(receipt, contracts) {
  for (const log of receipt.logs) {
    for (const contract of contracts) {
      let parsed = null;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        /* not this contract's event */
      }
      if (!parsed) continue;
      const args = parsed.fragment.inputs
        .map((input, i) => `${input.name}=${formatArg(parsed.args[i])}`)
        .join(", ");
      console.log(`   event   : ${parsed.name}(${args})`);
      break;
    }
  }
}

function formatArg(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.startsWith("0x") && value.length === 66) {
    // try to render bytes32 ids as readable strings
    try {
      const text = hre.ethers.decodeBytes32String(value);
      if (text) return `"${text}"`;
    } catch {
      /* generic bytes32 (e.g. a hash) — leave as hex */
    }
  }
  return `${value}`;
}

/** Run an action that is EXPECTED to revert; print the outcome either way. */
async function expectRevert(description, txPromise) {
  step(`${description}  (expected to be rejected)`);
  try {
    const tx = await txPromise;
    await tx.wait();
    console.log("   ✗ UNEXPECTED: transaction succeeded — check the contract!");
  } catch (err) {
    console.log(`   ✓ rejected by contract: ${revertReason(err)}`);
  }
}

function revertReason(err) {
  const msg = err.shortMessage || err.message || String(err);
  const match = msg.match(/reverted with custom error '([^']+)'/);
  if (match) return match[1];
  return msg.split("\n")[0];
}

function toBatchId(text) {
  return hre.ethers.encodeBytes32String(text);
}

function fromBatchId(bytes) {
  return hre.ethers.decodeBytes32String(bytes);
}

const STATUS_NAMES = ["None", "Active", "Dispensed", "Quarantined", "Recalled"];

module.exports = {
  ROLE_NAMES,
  STATUS_NAMES,
  loadDeployment,
  saveDeployment,
  getRoleSigners,
  getContracts,
  labelFor,
  short,
  banner,
  step,
  sendTx,
  printEvents,
  expectRevert,
  revertReason,
  toBatchId,
  fromBatchId,
};
