/**
 * Demo helper — queue a temperature spike for the running oracle service.
 *
 *   BATCH_ID=<id> TEMP=15.2 node scripts/inject-excursion.js
 *
 * Writes oracle/inject.json; the oracle service (oracle/index.js) picks it up
 * on its next cycle, uses it as the sensor reading for that batch once, and
 * deletes the file. Plain node script — no chain connection needed.
 */
const fs = require("fs");
const path = require("path");

const batchId = process.env.BATCH_ID || null;
const temp = parseFloat(process.env.TEMP ?? "15.0");
if (Number.isNaN(temp)) throw new Error("TEMP must be a number, e.g. TEMP=15.2");

const file = path.join(__dirname, "..", "oracle", "inject.json");
fs.writeFileSync(file, JSON.stringify({ batchId, tempC: temp }, null, 2));

console.log(`Queued injected reading: ${temp} °C` + (batchId ? ` for batch ${batchId}` : " (all tracked batches)"));
console.log(`→ ${file}`);
console.log("The running oracle service will consume it on its next cycle.");
