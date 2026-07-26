const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 24 * 60 * 60;
const Status = { None: 0, Active: 1, Dispensed: 2, Quarantined: 3, Recalled: 4 };
const id = (text) => ethers.encodeBytes32String(text);
const HASH = ethers.keccak256(ethers.toUtf8Bytes("metadata-record"));

describe("ColdChainMonitor", function () {
  async function deployFixture() {
    const [admin, manufacturer, oracle, outsider] = await ethers.getSigners();

    const registry = await ethers.deployContract("BatchRegistry", [admin.address]);
    const monitor = await ethers.deployContract("ColdChainMonitor", [
      await registry.getAddress(),
      admin.address,
    ]);

    await registry.grantRole(await registry.MANUFACTURER_ROLE(), manufacturer.address);
    await registry.grantRole(await registry.MONITOR_ROLE(), await monitor.getAddress());
    await monitor.grantRole(await monitor.ORACLE_ROLE(), oracle.address);

    const now = await time.latest();
    await registry
      .connect(manufacturer)
      .registerBatch(id("B-1"), HASH, now - DAY, now + 180 * DAY);

    return { registry, monitor, admin, manufacturer, oracle, outsider };
  }

  const ts = async (offset = 0) => (await time.latest()) + offset;

  // ------------------------------------------------------------ access

  it("only ORACLE_ROLE can report readings", async function () {
    const { monitor, outsider } = await loadFixture(deployFixture);
    await expect(
      monitor.connect(outsider).reportReading(id("B-1"), 500, await ts())
    ).to.be.revertedWithCustomError(monitor, "AccessControlUnauthorizedAccount");
  });

  // ------------------------------------------------------------ happy path

  it("records an in-range reading without any excursion", async function () {
    const { monitor, oracle } = await loadFixture(deployFixture);
    const when = await ts();

    await expect(monitor.connect(oracle).reportReading(id("B-1"), 450, when))
      .to.emit(monitor, "ReadingRecorded")
      .withArgs(id("B-1"), 450, when);

    const state = await monitor.getMonitorState(id("B-1"));
    expect(state.readingCount).to.equal(1);
    expect(state.excursionCount).to.equal(0);
    expect(state.lastTempCenti).to.equal(450);
    expect(state.quarantineTriggered).to.equal(false);
  });

  // ------------------------------------------- excursion → auto-quarantine

  it("quarantines the batch in the registry on an out-of-range reading (cross-contract)", async function () {
    const { registry, monitor, oracle } = await loadFixture(deployFixture);

    // default envelope 2.00–8.00 °C, limit 1 → a 15.2 °C reading triggers it
    const tx = monitor.connect(oracle).reportReading(id("B-1"), 1520, await ts());
    await expect(tx)
      .to.emit(monitor, "TemperatureExcursion")
      .withArgs(id("B-1"), 1520, 200, 800, 1);
    await expect(tx).to.emit(monitor, "QuarantineTriggered");
    await expect(tx).to.emit(registry, "BatchQuarantined");

    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Quarantined);
    const state = await monitor.getMonitorState(id("B-1"));
    expect(state.quarantineTriggered).to.equal(true);
  });

  it("also fires for readings below the envelope (frozen product in a fridge lane)", async function () {
    const { registry, monitor, oracle } = await loadFixture(deployFixture);
    await monitor.connect(oracle).reportReading(id("B-1"), -50, await ts());
    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Quarantined);
  });

  it("respects a per-batch excursion limit (stability budget)", async function () {
    const { registry, monitor, admin, oracle } = await loadFixture(deployFixture);
    // override: same envelope but tolerate 2 excursions, quarantine on the 3rd
    await monitor.connect(admin).setThreshold(id("B-1"), 200, 800, 3);

    await monitor.connect(oracle).reportReading(id("B-1"), 900, await ts(10));
    await monitor.connect(oracle).reportReading(id("B-1"), 950, await ts(20));
    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Active); // still ok

    await monitor.connect(oracle).reportReading(id("B-1"), 1000, await ts(30));
    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Quarantined);

    const state = await monitor.getMonitorState(id("B-1"));
    expect(state.excursionCount).to.equal(3);
  });

  it("supports a custom envelope for frozen products", async function () {
    const { registry, monitor, admin, oracle } = await loadFixture(deployFixture);
    // -25.00 .. -15.00 °C envelope: 5 °C is now a violation, -20 °C is fine
    await monitor.connect(admin).setThreshold(id("B-1"), -2500, -1500, 1);

    await monitor.connect(oracle).reportReading(id("B-1"), -2000, await ts(10));
    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Active);

    await monitor.connect(oracle).reportReading(id("B-1"), 500, await ts(20));
    expect(await registry.getStatus(id("B-1"))).to.equal(Status.Quarantined);
  });

  // ------------------------------------------------------- input validation

  it("rejects sensor-fault temperatures outside the physical range", async function () {
    const { monitor, oracle } = await loadFixture(deployFixture);
    await expect(
      monitor.connect(oracle).reportReading(id("B-1"), 30000, await ts())
    ).to.be.revertedWithCustomError(monitor, "InvalidReading");
    await expect(
      monitor.connect(oracle).reportReading(id("B-1"), -5000, await ts())
    ).to.be.revertedWithCustomError(monitor, "InvalidReading");
  });

  it("rejects stale (non-increasing) and far-future timestamps", async function () {
    const { monitor, oracle } = await loadFixture(deployFixture);
    const when = await ts();
    await monitor.connect(oracle).reportReading(id("B-1"), 450, when);

    await expect(
      monitor.connect(oracle).reportReading(id("B-1"), 460, when) // same ts
    ).to.be.revertedWithCustomError(monitor, "StaleReading");
    await expect(
      monitor.connect(oracle).reportReading(id("B-1"), 460, when + DAY) // clock way off
    ).to.be.revertedWithCustomError(monitor, "FutureReading");
  });

  it("rejects readings for unknown or non-active batches", async function () {
    const { registry, monitor, admin, oracle } = await loadFixture(deployFixture);

    await expect(
      monitor.connect(oracle).reportReading(id("GHOST"), 450, await ts())
    ).to.be.revertedWithCustomError(monitor, "BatchNotActive");

    await registry.connect(admin).recallBatch(id("B-1"), "spoiled");
    await expect(
      monitor.connect(oracle).reportReading(id("B-1"), 450, await ts())
    ).to.be.revertedWithCustomError(monitor, "BatchNotActive");
  });

  // ------------------------------------------------------------ thresholds

  it("validates threshold configuration and restricts it to the admin", async function () {
    const { monitor, admin, oracle } = await loadFixture(deployFixture);
    await expect(
      monitor.connect(oracle).setThreshold(id("B-1"), 200, 800, 1)
    ).to.be.revertedWithCustomError(monitor, "AccessControlUnauthorizedAccount");
    await expect(
      monitor.connect(admin).setThreshold(id("B-1"), 800, 200, 1) // min >= max
    ).to.be.revertedWithCustomError(monitor, "InvalidThreshold");
    await expect(
      monitor.connect(admin).setThreshold(id("B-1"), 200, 800, 0) // zero limit
    ).to.be.revertedWithCustomError(monitor, "InvalidThreshold");

    await expect(monitor.connect(admin).setThreshold(id("B-1"), 100, 900, 2))
      .to.emit(monitor, "ThresholdSet")
      .withArgs(id("B-1"), 100, 900, 2);
    const [min, max, limit] = await monitor.getThreshold(id("B-1"));
    expect([min, max, limit]).to.deep.equal([100n, 900n, 2n]);
  });

  it("falls back to the default WHO envelope when no override is set", async function () {
    const { monitor } = await loadFixture(deployFixture);
    const [min, max, limit] = await monitor.getThreshold(id("ANY"));
    expect(min).to.equal(200);
    expect(max).to.equal(800);
    expect(limit).to.equal(1);
  });
});
