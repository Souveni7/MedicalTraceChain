/**
 * Cold-chain oracle service (off-chain computational component + IoT mock).
 *
 *   npx hardhat run oracle/index.js --network localhost
 *
 * Loop, once per cycle, for every Active batch it discovered on-chain:
 *   1. IoT SIMULATOR  — generates 3 raw sensor samples (normally 2–8 °C; a
 *      spike can be injected with scripts/inject-excursion.js).
 *   2. OFF-CHAIN COMPUTATION — logs the raw samples to the off-chain store
 *      (db/sensor-log/*.jsonl), discards sensor-fault samples, and averages
 *      the rest into one summarised reading. Raw data never goes on-chain.
 *   3. ORACLE SUBMISSION — signs reportReading() as the authorised oracle
 *      account. The ColdChainMonitor contract then applies the on-chain
 *      business logic (envelope check → excursion count → auto-quarantine).
 *
 * Batches are discovered from BatchRegistered events; monitoring stops
 * automatically once a batch leaves the Active state.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const store = require("../offchain/store");
const {
  getContracts,
  getRoleSigners,
  fromBatchId,
  banner,
  revertReason,
} = require("../scripts/helpers");

const INJECT_FILE = path.join(__dirname, "inject.json");
const CYCLE_MS = hre.network.name === "sepolia" ? 20000 : 5000;
const SENSOR_FAULT_LIMIT_C = 85;

/** batchIdText → { idBytes, stopped } */
const tracked = new Map();
let lastScannedBlock = 0;

// ---------------------------------------------------------- IoT simulator

/** Three raw samples around a healthy 5 °C, ±1.4 °C sensor noise. */
function sampleSensor(injectedTempC) {
  const base = injectedTempC ?? 5.0;
  return Array.from({ length: 3 }, () => {
    const noise = injectedTempC == null ? (Math.random() - 0.5) * 2.8 : 0;
    return Math.round((base + noise) * 100) / 100;
  });
}

function consumeInjection(batchIdText) {
  if (!fs.existsSync(INJECT_FILE)) return null;
  try {
    const { batchId, tempC } = JSON.parse(fs.readFileSync(INJECT_FILE, "utf8"));
    if (batchId && batchId !== batchIdText) return null;
    fs.unlinkSync(INJECT_FILE); // consume once
    return tempC;
  } catch {
    return null;
  }
}

// ---------------------------------------------------- off-chain computation

/** Filter obviously broken samples, average the rest (centi-degrees). */
function aggregate(samples) {
  const valid = samples.filter((t) => Math.abs(t) <= SENSOR_FAULT_LIMIT_C);
  if (valid.length === 0) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Math.round(avg * 100);
}

// ------------------------------------------------------------ main service

async function discoverBatches(registry) {
  const current = await hre.ethers.provider.getBlockNumber();
  if (current < lastScannedBlock) return;
  const events = await registry.queryFilter(
    registry.filters.BatchRegistered(),
    lastScannedBlock,
    current
  );
  lastScannedBlock = current + 1;
  for (const ev of events) {
    const text = fromBatchId(ev.args.batchId);
    if (!tracked.has(text)) {
      tracked.set(text, { idBytes: ev.args.batchId, stopped: false });
      console.log(`\n📦 now monitoring batch ${text}`);
    }
  }
}

async function cycle(registry, monitor, oracle) {
  await discoverBatches(registry);

  for (const [text, info] of tracked) {
    if (info.stopped) continue;

    // stop cleanly for batches that left the Active state
    const status = await registry.getStatus(info.idBytes);
    if (Number(status) !== 1 /* Active */) {
      info.stopped = true;
      console.log(`🛑 batch ${text} is no longer Active — monitoring stopped`);
      continue;
    }

    // 1. IoT simulator
    const injected = consumeInjection(text);
    const samples = sampleSensor(injected);
    if (injected != null) {
      console.log(`\n🔥 INJECTED reading for ${text}: ${injected} °C`);
    }

    // 2. off-chain: log raw samples, then aggregate
    store.appendLog("sensor-log", text, {
      at: new Date().toISOString(),
      samples,
    });
    const tempCenti = aggregate(samples);
    if (tempCenti === null) {
      console.log(`   ${text}: all samples were sensor faults — nothing to report`);
      continue;
    }

    // 3. submit on-chain as the oracle
    try {
      const tx = await monitor
        .connect(oracle)
        .reportReading(info.idBytes, tempCenti, Math.floor(Date.now() / 1000));
      const receipt = await tx.wait();
      const flags = [];
      for (const log of receipt.logs) {
        let parsed = null;
        try { parsed = monitor.interface.parseLog(log); } catch { /* other contract */ }
        if (!parsed) {
          try { parsed = registry.interface.parseLog(log); } catch { /* skip */ }
        }
        if (parsed && parsed.name !== "ReadingRecorded") flags.push(parsed.name);
      }
      const note = flags.length ? `  ⚠ ${flags.join(" → ")}` : "";
      console.log(
        `   ${text}: samples [${samples.join(", ")}] °C → reported ${(tempCenti / 100).toFixed(2)} °C  (tx ${tx.hash.slice(0, 10)}…)${note}`
      );
      if (flags.includes("BatchQuarantined")) {
        console.log(`   ⛔ contract auto-quarantined ${text} — run 03-verify.js to see it`);
      }
    } catch (err) {
      console.log(`   ${text}: report rejected — ${revertReason(err)}`);
    }
  }
}

async function main() {
  const { registry, monitor, dep } = await getContracts();
  const { oracle } = await getRoleSigners();
  lastScannedBlock = dep.deployBlock || 0;

  banner(`Cold-chain oracle service on ${hre.network.name}`);
  console.log(`   oracle account : ${oracle.address}`);
  console.log(`   monitor        : ${await monitor.getAddress()}`);
  console.log(`   cycle          : every ${CYCLE_MS / 1000}s`);
  console.log(`   inject a spike : BATCH_ID=<id> TEMP=15 node scripts/inject-excursion.js`);
  console.log("   stop with Ctrl+C\n");

  // simple polling loop; a production oracle would use websocket subscriptions
  for (;;) {
    try {
      await cycle(registry, monitor, oracle);
    } catch (err) {
      console.error(`cycle failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, CYCLE_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
