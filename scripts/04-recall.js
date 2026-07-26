/**
 * Demo step 5 — FR4: regulator-initiated recall + off-chain notifier.
 *
 *   BATCH_ID=<id> npx hardhat run scripts/04-recall.js --network localhost
 *
 * The regulator recalls the batch on-chain (emergency-stop pattern, terminal
 * state). The OFF-chain notifier then reconstructs every party that ever
 * held the batch from the on-chain custody history and "notifies" them
 * (printed here; would be email/SMS in production).
 */
const store = require("../offchain/store");
const {
  getContracts,
  getRoleSigners,
  labelFor,
  banner,
  step,
  sendTx,
  toBatchId,
} = require("./helpers");

async function main() {
  const batchId = process.env.BATCH_ID;
  if (!batchId) throw new Error("Set BATCH_ID, e.g. BATCH_ID=PHX-… npx hardhat run …");
  const reason = process.env.REASON || "Contamination detected in lot sample";
  const id = toBatchId(batchId);

  const { registry, dep } = await getContracts();
  const { regulator } = await getRoleSigners();

  banner(`FR4 — Recall of batch ${batchId}`);

  await sendTx(
    `regulator calls recallBatch("${batchId}", "${reason}")`,
    registry.connect(regulator).recallBatch(id, reason),
    [registry]
  );

  step("Off-chain recall notifier: reconstructing affected parties from chain");
  const history = await registry.getCustodyHistory(id);
  const holders = new Set();
  for (const record of history) holders.add(record.to);

  const notified = [];
  for (const holder of holders) {
    const label = labelFor(dep, holder);
    console.log(`   ✉ notifying ${label}: "Batch ${batchId} recalled — ${reason}"`);
    notified.push({ party: label, address: holder });
  }
  const file = store.save("recalls", batchId, {
    batchId,
    reason,
    recalledAt: new Date().toISOString(),
    notifiedParties: notified,
  });
  console.log(`   off-chain notification log written to ${file}`);

  banner(`Batch ${batchId} is RECALLED — any further transfer/dispense will revert`);
  console.log("   try it: re-run scripts/03-verify.js to see the verdict change");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
