/**
 * Fallback for the live demo — submit one oracle reading directly, without
 * the long-running oracle service.
 *
 *   BATCH_ID=<id> TEMP=15.2 npx hardhat run scripts/manual-report.js --network localhost
 *
 * Signs reportReading() as the oracle account; the ColdChainMonitor contract
 * applies exactly the same on-chain excursion logic as in the service path.
 */
const {
  getContracts,
  getRoleSigners,
  banner,
  sendTx,
  toBatchId,
} = require("./helpers");

async function main() {
  const batchId = process.env.BATCH_ID;
  if (!batchId) throw new Error("Set BATCH_ID, e.g. BATCH_ID=PHX-… npx hardhat run …");
  const tempC = parseFloat(process.env.TEMP ?? "5.0");
  if (Number.isNaN(tempC)) throw new Error("TEMP must be a number, e.g. TEMP=15.2");
  const tempCenti = Math.round(tempC * 100);

  const { registry, monitor } = await getContracts();
  const { oracle } = await getRoleSigners();

  banner(`Oracle: manual reading ${tempC} °C for batch ${batchId}`);

  await sendTx(
    `oracle calls reportReading("${batchId}", ${tempCenti} centi-°C)`,
    monitor
      .connect(oracle)
      .reportReading(toBatchId(batchId), tempCenti, Math.floor(Date.now() / 1000)),
    [monitor, registry] // decode events from both contracts (incl. BatchQuarantined)
  );

  const state = await monitor.getMonitorState(toBatchId(batchId));
  console.log(`\n   readings=${state.readingCount}  excursions=${state.excursionCount}  quarantineTriggered=${state.quarantineTriggered}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
