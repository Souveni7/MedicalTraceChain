/**
 * Off-chain data storage component.
 *
 * A minimal file-based store standing in for the cloud / shared database of
 * the full architecture. It holds everything that must NOT live on-chain:
 * raw batch metadata, patient PII, and raw sensor logs. The chain only ever
 * sees keccak256 hashes of these records (hash-anchoring pattern), which is
 * what lets us verify integrity without exposing the data.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DB_ROOT = path.join(__dirname, "..", "db");

/** Deterministically serialise an object (recursively sorted keys) so the
 *  same record always produces the same hash. */
function canonicalise(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** keccak256 hash of a record's canonical form — the value that goes on-chain. */
function hashRecord(record) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalise(record)));
}

function recordPath(collection, id) {
  return path.join(DB_ROOT, collection, `${id}.json`);
}

/** Persist a record off-chain. Returns the file path it was written to. */
function save(collection, id, record) {
  const file = recordPath(collection, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/** Load a record, or null if it does not exist. */
function load(collection, id) {
  const file = recordPath(collection, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Append a line to a JSONL log (used for raw sensor readings). */
function appendLog(collection, id, entry) {
  const file = path.join(DB_ROOT, collection, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  return file;
}

module.exports = { DB_ROOT, canonicalise, hashRecord, save, load, appendLog, recordPath };
