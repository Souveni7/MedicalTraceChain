/**
 * Demo step 3 — FR3: point-of-dispensing verification.
 *
 *   BATCH_ID=<id> npx hardhat run scripts/03-verify.js --network localhost
 *
 * Read-only: pulls the on-chain state + custody history, then re-hashes the
 * OFF-chain metadata record and compares it with the ON-chain hash anchor —
 * proving the off-chain record has not been tampered with.
 */
const store = require("../offchain/store");
const {
  getContracts,
  labelFor,
  banner,
  step,
  toBatchId,
  STATUS_NAMES,
} = require("./helpers");

const VERDICTS = {
  Active: "✅ VERIFIED — safe to dispense",
  Dispensed: "⚠️ ALREADY DISPENSED — a second scan may indicate a counterfeit copy",
  Quarantined: "⛔ QUARANTINED (cold-chain violation) — DO NOT DISPENSE",
  Recalled: "⛔ RECALLED — DO NOT DISPENSE, return to supplier",
};

async function main() {
  const batchId = process.env.BATCH_ID;
  if (!batchId) throw new Error("Set BATCH_ID, e.g. BATCH_ID=PHX-… npx hardhat run …");
  const id = toBatchId(batchId);

  const { registry, dep } = await getContracts();

  banner(`FR3 — Verification lookup for batch ${batchId}`);

  step("On-chain state (BatchRegistry.verifyBatch)");
  const info = await registry.verifyBatch(id);
  const statusName = STATUS_NAMES[Number(info.status)];
  console.log(`   status          : ${statusName}`);
  console.log(`   dispensable     : ${info.dispensable}`);
  console.log(`   manufacturer    : ${labelFor(dep, info.manufacturer)}`);
  console.log(`   current holder  : ${labelFor(dep, info.currentCustodian)}`);
  console.log(`   produced        : ${new Date(Number(info.productionDate) * 1000).toISOString()}`);
  console.log(`   expires         : ${new Date(Number(info.expiryDate) * 1000).toISOString()}`);
  console.log(`   on-chain hash   : ${info.metadataHash}`);

  step("Custody history (on-chain)");
  const history = await registry.getCustodyHistory(id);
  for (const [i, record] of history.entries()) {
    const from = record.from === "0x0000000000000000000000000000000000000000"
        ? "REGISTERED"
        : labelFor(dep, record.from);
    console.log(`   ${i}. ${from} → ${labelFor(dep, record.to)}  @ ${record.location}`);
  }

  step("Integrity check: re-hash the OFF-chain metadata record");
  const metadata = store.load("batches", batchId);
  if (!metadata) {
    console.log("   ✗ no off-chain metadata record found — cannot check integrity");
  } else {
    const recomputed = store.hashRecord(metadata);
    console.log(`   off-chain record: ${store.recordPath("batches", batchId)}`);
    console.log(`   recomputed hash : ${recomputed}`);
    console.log(
      recomputed === info.metadataHash
        ? "   ✓ MATCHES the on-chain anchor — metadata is authentic and untampered"
        : "   ✗ HASH MISMATCH — the off-chain record has been TAMPERED with!"
    );
  }

  let verdict = VERDICTS[statusName] || "✗ UNKNOWN BATCH";
  if (statusName === "Active" && !info.dispensable) {
    verdict = "⛔ EXPIRED — DO NOT DISPENSE";
  }
  banner(`VERDICT: ${verdict}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
