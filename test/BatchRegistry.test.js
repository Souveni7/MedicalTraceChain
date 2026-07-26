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

describe("BatchRegistry", function () {
  async function deployFixture() {
    const [admin, manufacturer, distributor, pharmacy, outsider, monitor] =
      await ethers.getSigners();

    const registry = await ethers.deployContract("BatchRegistry", [admin.address]);

    await registry.grantRole(await registry.MANUFACTURER_ROLE(), manufacturer.address);
    await registry.grantRole(await registry.DISTRIBUTOR_ROLE(), distributor.address);
    await registry.grantRole(await registry.PHARMACY_ROLE(), pharmacy.address);
    // for these unit tests an EOA plays the ColdChainMonitor contract
    await registry.grantRole(await registry.MONITOR_ROLE(), monitor.address);

    return { registry, admin, manufacturer, distributor, pharmacy, outsider, monitor };
  }

  /** Fixture with one active batch already registered. */
  async function registeredFixture() {
    const ctx = await deployFixture();
    const now = await time.latest();
    ctx.production = now - DAY;
    ctx.expiry = now + 180 * DAY;
    await ctx.registry
      .connect(ctx.manufacturer)
      .registerBatch(id("B-1"), HASH, ctx.production, ctx.expiry);
    return ctx;
  }

  // ------------------------------------------------------ FR1: registration

  describe("registerBatch (FR1)", function () {
    it("registers a batch, sets manufacturer as custodian, emits event", async function () {
      const { registry, manufacturer } = await loadFixture(deployFixture);
      const now = await time.latest();

      await expect(
        registry.connect(manufacturer).registerBatch(id("B-1"), HASH, now - DAY, now + DAY)
      )
        .to.emit(registry, "BatchRegistered")
        .withArgs(id("B-1"), manufacturer.address, HASH, now - DAY, now + DAY);

      const info = await registry.verifyBatch(id("B-1"));
      expect(info.status).to.equal(Status.Active);
      expect(info.dispensable).to.equal(true);
      expect(info.currentCustodian).to.equal(manufacturer.address);
      expect(info.metadataHash).to.equal(HASH);
      expect(info.transferCount).to.equal(1); // the registration record
    });

    it("rejects a caller without MANUFACTURER_ROLE (RBAC)", async function () {
      const { registry, distributor } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(
        registry.connect(distributor).registerBatch(id("B-1"), HASH, now - DAY, now + DAY)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects duplicate batch ids", async function () {
      const { registry, manufacturer } = await loadFixture(registeredFixture);
      const now = await time.latest();
      await expect(
        registry.connect(manufacturer).registerBatch(id("B-1"), HASH, now - DAY, now + DAY)
      ).to.be.revertedWithCustomError(registry, "BatchAlreadyExists");
    });

    it("rejects expiry before production and future production dates", async function () {
      const { registry, manufacturer } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(
        registry.connect(manufacturer).registerBatch(id("B-2"), HASH, now, now - DAY)
      ).to.be.revertedWithCustomError(registry, "InvalidDates");
      await expect(
        registry.connect(manufacturer).registerBatch(id("B-2"), HASH, now + 10 * DAY, now + 20 * DAY)
      ).to.be.revertedWithCustomError(registry, "InvalidDates");
    });

    it("is blocked while the global circuit breaker is paused", async function () {
      const { registry, admin, manufacturer } = await loadFixture(deployFixture);
      const now = await time.latest();
      await registry.connect(admin).pause();
      await expect(
        registry.connect(manufacturer).registerBatch(id("B-2"), HASH, now - DAY, now + DAY)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await registry.connect(admin).unpause();
      await expect(
        registry.connect(manufacturer).registerBatch(id("B-2"), HASH, now - DAY, now + DAY)
      ).to.emit(registry, "BatchRegistered");
    });
  });

  // -------------------------------------------------- FR2: custody transfer

  describe("transferCustody (FR2)", function () {
    it("moves custody along the chain and records history", async function () {
      const { registry, manufacturer, distributor, pharmacy } =
        await loadFixture(registeredFixture);

      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), distributor.address, "DC-1")
      )
        .to.emit(registry, "CustodyTransferred")
        .withArgs(id("B-1"), manufacturer.address, distributor.address, "DC-1");
      await registry.connect(distributor).transferCustody(id("B-1"), pharmacy.address, "PH-1");

      const history = await registry.getCustodyHistory(id("B-1"));
      expect(history.length).to.equal(3);
      expect(history[1].from).to.equal(manufacturer.address);
      expect(history[2].to).to.equal(pharmacy.address);
      expect(history[2].location).to.equal("PH-1");

      const info = await registry.verifyBatch(id("B-1"));
      expect(info.currentCustodian).to.equal(pharmacy.address);
    });

    it("rejects a sender who is not the current custodian", async function () {
      const { registry, distributor, pharmacy } = await loadFixture(registeredFixture);
      await expect(
        registry.connect(distributor).transferCustody(id("B-1"), pharmacy.address, "X")
      ).to.be.revertedWithCustomError(registry, "NotCurrentCustodian");
    });

    it("rejects recipients without any participant role", async function () {
      const { registry, manufacturer, outsider } = await loadFixture(registeredFixture);
      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), outsider.address, "X")
      ).to.be.revertedWithCustomError(registry, "NotAParticipant");
    });

    it("rejects self-transfers and transfers of unknown batches", async function () {
      const { registry, manufacturer, distributor } = await loadFixture(registeredFixture);
      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), manufacturer.address, "X")
      ).to.be.revertedWithCustomError(registry, "SelfTransfer");
      await expect(
        registry.connect(manufacturer).transferCustody(id("NOPE"), distributor.address, "X")
      ).to.be.revertedWithCustomError(registry, "BatchNotFound");
    });

    it("rejects transfers of expired batches (business rule)", async function () {
      const { registry, manufacturer, distributor, expiry } =
        await loadFixture(registeredFixture);
      await time.increaseTo(expiry + 1);
      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), distributor.address, "X")
      ).to.be.revertedWithCustomError(registry, "BatchExpired");
    });
  });

  // ------------------------------------------------------- FR3: dispensing

  describe("dispenseBatch (FR3)", function () {
    async function atPharmacyFixture() {
      const ctx = await loadFixture(registeredFixture);
      await ctx.registry
        .connect(ctx.manufacturer)
        .transferCustody(id("B-1"), ctx.pharmacy.address, "PH-1");
      return ctx;
    }

    it("lets the holding pharmacy dispense; state becomes terminal", async function () {
      const { registry, pharmacy, distributor } = await atPharmacyFixture();

      await expect(registry.connect(pharmacy).dispenseBatch(id("B-1")))
        .to.emit(registry, "BatchDispensed")
        .withArgs(id("B-1"), pharmacy.address);
      expect(await registry.getStatus(id("B-1"))).to.equal(Status.Dispensed);

      // terminal: no further movement
      await expect(
        registry.connect(pharmacy).transferCustody(id("B-1"), distributor.address, "X")
      ).to.be.revertedWithCustomError(registry, "InvalidState");
    });

    it("rejects dispensing by a non-pharmacy or a non-custodian", async function () {
      const { registry, manufacturer, pharmacy } = await loadFixture(registeredFixture);
      // manufacturer holds the batch but has no PHARMACY_ROLE
      await expect(
        registry.connect(manufacturer).dispenseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      // pharmacy has the role but does not hold the batch yet
      await expect(
        registry.connect(pharmacy).dispenseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(registry, "NotCurrentCustodian");
    });

    it("rejects dispensing an expired batch", async function () {
      const ctx = await atPharmacyFixture();
      await time.increaseTo(ctx.expiry + 1);
      await expect(
        ctx.registry.connect(ctx.pharmacy).dispenseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(ctx.registry, "BatchExpired");
      const info = await ctx.registry.verifyBatch(id("B-1"));
      expect(info.dispensable).to.equal(false); // view agrees with the rule
    });
  });

  // --------------------------------------------- quarantine / release flow

  describe("quarantineBatch / releaseBatch", function () {
    it("only MONITOR_ROLE can quarantine; transfers are then blocked", async function () {
      const { registry, monitor, manufacturer, distributor, outsider } =
        await loadFixture(registeredFixture);

      await expect(
        registry.connect(outsider).quarantineBatch(id("B-1"), "x")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await expect(registry.connect(monitor).quarantineBatch(id("B-1"), "cold-chain"))
        .to.emit(registry, "BatchQuarantined")
        .withArgs(id("B-1"), "cold-chain");

      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), distributor.address, "X")
      ).to.be.revertedWithCustomError(registry, "InvalidState");
    });

    it("a regulator can release a quarantined batch back to Active", async function () {
      const { registry, monitor, admin, manufacturer } = await loadFixture(registeredFixture);
      await registry.connect(monitor).quarantineBatch(id("B-1"), "cold-chain");

      await expect(registry.connect(admin).releaseBatch(id("B-1")))
        .to.emit(registry, "BatchReleased")
        .withArgs(id("B-1"), admin.address);
      expect(await registry.getStatus(id("B-1"))).to.equal(Status.Active);

      // release is regulator-only and only from Quarantined
      await expect(
        registry.connect(manufacturer).releaseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(
        registry.connect(admin).releaseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(registry, "InvalidState");
    });
  });

  // ----------------------------------------------------------- FR4: recall

  describe("recallBatch (FR4)", function () {
    it("regulator can recall; recall is terminal (emergency stop)", async function () {
      const { registry, admin, manufacturer, distributor } =
        await loadFixture(registeredFixture);

      await expect(registry.connect(admin).recallBatch(id("B-1"), "contamination"))
        .to.emit(registry, "BatchRecalled")
        .withArgs(id("B-1"), admin.address, "contamination");

      await expect(
        registry.connect(manufacturer).transferCustody(id("B-1"), distributor.address, "X")
      ).to.be.revertedWithCustomError(registry, "InvalidState");
      await expect(
        registry.connect(admin).recallBatch(id("B-1"), "again")
      ).to.be.revertedWithCustomError(registry, "InvalidState");
      await expect(
        registry.connect(admin).releaseBatch(id("B-1"))
      ).to.be.revertedWithCustomError(registry, "InvalidState");
    });

    it("the batch's own manufacturer can recall, but nobody else", async function () {
      const { registry, manufacturer, distributor } = await loadFixture(registeredFixture);
      await expect(
        registry.connect(distributor).recallBatch(id("B-1"), "x")
      ).to.be.revertedWithCustomError(registry, "NotAuthorisedToRecall");
      await expect(
        registry.connect(manufacturer).recallBatch(id("B-1"), "faulty lot")
      ).to.emit(registry, "BatchRecalled");
    });

    it("can recall a batch that is already quarantined", async function () {
      const { registry, monitor, admin } = await loadFixture(registeredFixture);
      await registry.connect(monitor).quarantineBatch(id("B-1"), "cold-chain");
      await expect(
        registry.connect(admin).recallBatch(id("B-1"), "confirmed spoiled")
      ).to.emit(registry, "BatchRecalled");
      expect(await registry.getStatus(id("B-1"))).to.equal(Status.Recalled);
    });
  });

  // ---------------------------------------------------------------- views

  describe("views", function () {
    it("verifyBatch/getCustodyHistory revert for unknown batches", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.verifyBatch(id("NOPE"))).to.be.revertedWithCustomError(
        registry,
        "BatchNotFound"
      );
      await expect(
        registry.getCustodyHistory(id("NOPE"))
      ).to.be.revertedWithCustomError(registry, "BatchNotFound");
      expect(await registry.getStatus(id("NOPE"))).to.equal(Status.None);
    });

    it("isParticipant reflects granted roles", async function () {
      const { registry, manufacturer, distributor, pharmacy, outsider } =
        await loadFixture(deployFixture);
      expect(await registry.isParticipant(manufacturer.address)).to.equal(true);
      expect(await registry.isParticipant(distributor.address)).to.equal(true);
      expect(await registry.isParticipant(pharmacy.address)).to.equal(true);
      expect(await registry.isParticipant(outsider.address)).to.equal(false);
    });
  });
});
