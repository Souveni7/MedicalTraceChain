/**
 * Optional demo step — FR3 completion: pharmacy dispenses to a patient.
 *
 *   BATCH_ID=<id> npx hardhat run scripts/05-dispense.js --network localhost
 *
 * Marks the batch Dispensed on-chain (terminal state). The prescription
 * record containing patient PII is stored OFF-chain only — the chain never
 * sees any patient data (privacy & compliance NFR).
 */
const store = require("../offchain/store");
const {
  getContracts,
  getRoleSigners,
  banner,
  step,
  sendTx,
  toBatchId,
} = require("./helpers");

async function main() {
  const batchId = process.env.BATCH_ID;
  if (!batchId) throw new Error("Set BATCH_ID, e.g. BATCH_ID=PHX-… npx hardhat run …");
  const id = toBatchId(batchId);

  const { registry } = await getContracts();
  const { pharmacy } = await getRoleSigners();

  banner(`Dispensing batch ${batchId} to a patient`);

  await sendTx(
    "pharmacy calls dispenseBatch (must be current custodian + PHARMACY_ROLE)",
    registry.connect(pharmacy).dispenseBatch(id),
    [registry]
  );

  step("Off-chain PII store: prescription record (NEVER goes on-chain)");
  const record = {
    batchId,
    patientName: "Alice Nguyen",           // synthetic demo data
    medicareNumber: "2953 81234 1",        // synthetic demo data
    prescriptionId: "RX-77821",
    dispensedAt: new Date().toISOString(),
    pharmacy: "PHARMACY-KINGSFORD",
  };
  const file = store.save("pii", batchId, record);
  console.log(`   file: ${file}`);
  console.log("   ✓ on-chain footprint of this step: ONLY the BatchDispensed event —");
  console.log("     zero patient data touches the ledger (HIPAA/GDPR-aligned design)");

  banner(`Batch ${batchId} dispensed — lifecycle complete`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
