/**
 * Demo step 1 — FR1: batch registration with off-chain metadata + on-chain hash.
 *
 *   npx hardhat run scripts/01-register.js --network localhost
 *   BATCH_ID=PHX-001 npx hardhat run scripts/01-register.js --network sepolia
 *
 * 1. Builds the batch metadata record and stores it OFF-chain (db/batches/).
 * 2. Anchors only its keccak256 hash ON-chain via registerBatch().
 * 3. Shows RBAC working: the same call from a non-manufacturer is rejected.
 */
const hre = require("hardhat");
const store = require("../offchain/store");
const {
  getContracts,
  getRoleSigners,
  banner,
  step,
  sendTx,
  expectRevert,
  toBatchId,
} = require("./helpers");

const DAY = 24 * 60 * 60;

async function main() {
  const { registry } = await getContracts();
  const { manufacturer, distributor } = await getRoleSigners();

  const batchId =
    process.env.BATCH_ID || `PHX-${Date.now().toString(36).toUpperCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const productionDate = now - 3 * DAY;
  const expiryDate = now + 180 * DAY;

  banner(`FR1 — Register batch ${batchId}`);

  // ---- off-chain: full metadata record (never goes on-chain) -------------
  const metadata = {
    batchId,
    product: "ComirnaX mRNA vaccine, 0.3 mL dose",
    lotNumber: "LOT-2026-07-A",
    manufacturer: "PharmaCorp Pty Ltd",
    productionDate: new Date(productionDate * 1000).toISOString(),
    expiryDate: new Date(expiryDate * 1000).toISOString(),
    storageCondition: "2-8 °C (cold chain)",
  };
  const file = store.save("batches", batchId, metadata);
  const metadataHash = store.hashRecord(metadata);

  step("Off-chain storage: metadata record written");
  console.log(`   file    : ${file}`);
  console.log(`   contents: ${JSON.stringify(metadata)}`);
  step("Off-chain computation: keccak256 hash of the canonical record");
  console.log(`   hash    : ${metadataHash}   ← only THIS goes on-chain`);

  // ---- on-chain: register with the hash anchor ---------------------------
  await sendTx(
    `manufacturer calls registerBatch("${batchId}", <hash>, …)`,
    registry
      .connect(manufacturer)
      .registerBatch(toBatchId(batchId), metadataHash, productionDate, expiryDate),
    [registry]
  );

  // ---- RBAC negative case: distributor is not a licensed manufacturer ----
  await expectRevert(
    "distributor tries to register a batch without MANUFACTURER_ROLE",
    registry
      .connect(distributor)
      .registerBatch(toBatchId(`${batchId}-FAKE`), metadataHash, productionDate, expiryDate)
  );

  banner(`Batch ${batchId} registered — use this id in the next steps`);
  console.log(`   next: BATCH_ID=${batchId} npx hardhat run scripts/02-transfer.js --network ${hre.network.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
