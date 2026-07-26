COMP6452 Project 2 - Task 3
Pharmaceutical Supply Chain Traceability PoC ("pharma-chain")
=============================================================

A blockchain-based proof of concept for pharmaceutical batch traceability:
batch registration, custody transfer, point-of-dispensing verification,
regulator recall, and oracle-driven cold-chain monitoring with automatic
on-chain quarantine.

COMPONENTS
----------
On-chain (Solidity 0.8.24, two smart contracts with business logic):
  contracts/BatchRegistry.sol     FR1-FR4: registration, custody state
                                  machine, verification, recall/quarantine.
                                  Patterns: RBAC (OpenZeppelin AccessControl),
                                  state machine, emergency stop (per-batch
                                  recall + global Pausable), hash anchoring.
  contracts/ColdChainMonitor.sol  FR5: oracle ingress; validates readings,
                                  counts temperature excursions against a
                                  per-batch envelope, and auto-quarantines
                                  the batch via a cross-contract call.

Off-chain (Node.js):
  oracle/index.js                 Oracle service = IoT temperature simulator
                                  + off-chain computation (raw-sample logging,
                                  fault filtering, aggregation) + signed
                                  on-chain submission (ORACLE_ROLE account).
  offchain/store.js               Off-chain data store (file-based stand-in
                                  for a shared database): batch metadata,
                                  patient PII, raw sensor logs. Only keccak256
                                  hashes of records go on-chain.
  scripts/01..05-*.js             Demo drivers for each functional requirement
                                  (see DEMO_GUIDE.md in the parent directory).
  test/*.test.js                  31 unit tests (Hardhat + Chai).

DEPENDENCIES
------------
  - Node.js >= 18 (developed on v18.20.8; Node 20/22 also fine)
  - npm
  - Hardhat 2.x, @nomicfoundation/hardhat-toolbox, @openzeppelin/contracts,
    dotenv (all installed via npm; nothing global required)
  - For Sepolia only: an RPC endpoint (Alchemy/Infura free tier) and a funded
    test account.

SETUP
-----
  cd pharma-chain
  npm install
  npx hardhat compile
  npx hardhat test          # runs all 31 unit tests

RUNNING LOCALLY (quick start)
-----------------------------
Terminal A:   npx hardhat node
Terminal B:   npx hardhat run scripts/deploy.js --network localhost
              # then walk the batch lifecycle:
              BATCH_ID=PHX-001 (set as env var; PowerShell: $env:BATCH_ID="PHX-001")
              npx hardhat run scripts/01-register.js --network localhost
              npx hardhat run scripts/02-transfer.js --network localhost
              npx hardhat run scripts/03-verify.js   --network localhost
Terminal C:   npx hardhat run oracle/index.js --network localhost
              # inject a cold-chain violation (15 C against a 2-8 C envelope):
              node scripts/inject-excursion.js   (env: BATCH_ID, TEMP=15)
              # -> the batch is auto-quarantined on-chain; re-run 03-verify
Then:         npx hardhat run scripts/04-recall.js --network localhost
              npx hardhat run scripts/05-dispense.js --network localhost  (fresh batch)

Fallback without the long-running oracle service:
              npx hardhat run scripts/manual-report.js --network localhost
              (env: BATCH_ID, TEMP)

RUNNING ON SEPOLIA
------------------
  1. copy .env.example to .env
  2. npx hardhat run scripts/new-wallet.js   -> paste MNEMONIC into .env,
     set SEPOLIA_RPC_URL, fund account [0] from a Sepolia faucet
  3. npx hardhat run scripts/fund-accounts.js --network sepolia
  4. npx hardhat run scripts/deploy.js --network sepolia
     (writes addresses.txt with the deployed contract addresses)
  5. run the same demo scripts with --network sepolia

ACCOUNT / ROLE LAYOUT
---------------------
  index 0  admin + regulator (deployer)
  index 1  manufacturer          index 3  pharmacy
  index 2  distributor           index 4  oracle node
  ColdChainMonitor contract holds MONITOR_ROLE on BatchRegistry, so only it
  can quarantine batches; only the oracle account can feed it readings.

NOTES
-----
  - db/ (off-chain store) and deployments/localhost.json are runtime data and
    are git-ignored; they regenerate when the demo runs.
  - The submission archive must not contain node_modules/, artifacts/, cache/,
    or .env (see .gitignore).
