require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Five accounts are derived from one mnemonic so the same role layout
// (0=admin/regulator, 1=manufacturer, 2=distributor, 3=pharmacy, 4=oracle)
// works identically on the local network and on Sepolia.
const accounts = process.env.MNEMONIC
  ? { mnemonic: process.env.MNEMONIC, count: 5 }
  : undefined; // hardhat's built-in test accounts

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      // no-registration public endpoints; SEPOLIA_RPC_URL overrides if set
      // (verified reachable alternative: https://sepolia.drpc.org)
      url: process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      accounts,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
};
