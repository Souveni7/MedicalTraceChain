/**
 * Demo step 2 — FR2: custody transfers along the supply chain.
 *
 *   BATCH_ID=<id> npx hardhat run scripts/02-transfer.js --network localhost
 *
 * manufacturer → distributor → pharmacy, then a deliberately ILLEGAL transfer
 * (the distributor no longer holds the batch) to show the state machine +
 * custodian check rejecting it.
 */
const store = require("../offchain/store");
const {
  getContracts,
  getRoleSigners,
  labelFor,
  banner,
  sendTx,
  expectRevert,
  step,
  toBatchId,
} = require("./helpers");

async function main() {
  const batchId = process.env.BATCH_ID;
  if (!batchId) throw new Error("Set BATCH_ID, e.g. BATCH_ID=PHX-… npx hardhat run …");
  if (!store.load("batches", batchId)) {
    console.warn(`   (note: no off-chain record for ${batchId} — did step 01 run?)`);
  }
  const id = toBatchId(batchId);

  const { registry, dep } = await getContracts();
  const { manufacturer, distributor, pharmacy } = await getRoleSigners();

  banner(`FR2 — Custody transfers for batch ${batchId}`);

  await sendTx(
    "manufacturer → distributor (handover at distribution centre DC-SYD-01)",
    registry.connect(manufacturer).transferCustody(id, distributor.address, "DC-SYD-01"),
    [registry]
  );

  await sendTx(
    "distributor → pharmacy (delivery to PHARMACY-KINGSFORD)",
    registry.connect(distributor).transferCustody(id, pharmacy.address, "PHARMACY-KINGSFORD"),
    [registry]
  );

  await expectRevert(
    "distributor tries to transfer AGAIN after handing the batch off",
    registry.connect(distributor).transferCustody(id, manufacturer.address, "NOWHERE")
  );

  step("Current custody chain (read from on-chain history)");
  const history = await registry.getCustodyHistory(id);
  for (const [i, record] of history.entries()) {
    const from = record.from === "0x0000000000000000000000000000000000000000"
        ? "REGISTERED"
        : labelFor(dep, record.from);
    const when = new Date(Number(record.timestamp) * 1000).toISOString();
    console.log(`   ${i}. ${from} → ${labelFor(dep, record.to)}  @ ${record.location}  (${when})`);
  }

  banner(`Batch ${batchId} now held by the pharmacy`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
