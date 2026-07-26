// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IBatchRegistry} from "./interfaces/IBatchRegistry.sol";

/// @title BatchRegistry
/// @notice Core traceability contract for the pharmaceutical supply chain PoC.
///         Covers FR1 (batch registration), FR2 (custody transfer),
///         FR3 (verification lookup) and FR4 (recall).
///
///         Applied design patterns:
///         - Access Restriction / RBAC: OpenZeppelin AccessControl replaces the
///           permissioned-network membership of the original Fabric design;
///           only licensed participants hold writer roles.
///         - State Machine: every batch follows the BatchStatus lifecycle and
///           each mutating function is only legal in specific states.
///         - Emergency Stop: `recallBatch` halts a single batch permanently
///           (circuit breaker per batch); `pause` halts all writes globally.
///         - Off-chain storage / hash anchoring: only a keccak256 hash of the
///           batch metadata is stored on-chain; the raw metadata and all
///           patient PII stay off-chain (privacy & compliance NFR).
contract BatchRegistry is IBatchRegistry, AccessControl, Pausable {
    // ---------------------------------------------------------------- roles

    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant PHARMACY_ROLE = keccak256("PHARMACY_ROLE");
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    /// @dev Held by the ColdChainMonitor contract, which is the only party
    ///      allowed to quarantine a batch automatically.
    bytes32 public constant MONITOR_ROLE = keccak256("MONITOR_ROLE");

    // ---------------------------------------------------------------- types

    struct Batch {
        bytes32 metadataHash; // keccak256 of the off-chain metadata record
        address manufacturer;
        address currentCustodian;
        uint64 productionDate;
        uint64 expiryDate;
        BatchStatus status;
    }

    struct CustodyRecord {
        address from;
        address to;
        uint64 timestamp;
        string location; // coarse handover location code, never PII
    }

    // -------------------------------------------------------------- storage

    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => CustodyRecord[]) private _custodyHistory;

    // --------------------------------------------------------------- events

    event BatchRegistered(
        bytes32 indexed batchId,
        address indexed manufacturer,
        bytes32 metadataHash,
        uint64 productionDate,
        uint64 expiryDate
    );
    event CustodyTransferred(
        bytes32 indexed batchId,
        address indexed from,
        address indexed to,
        string location
    );
    event BatchDispensed(bytes32 indexed batchId, address indexed pharmacy);
    event BatchQuarantined(bytes32 indexed batchId, string reason);
    event BatchReleased(bytes32 indexed batchId, address indexed regulator);
    event BatchRecalled(
        bytes32 indexed batchId,
        address indexed initiator,
        string reason
    );

    // --------------------------------------------------------------- errors

    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error InvalidDates(uint64 productionDate, uint64 expiryDate);
    error BatchExpired(bytes32 batchId, uint64 expiryDate);
    error NotCurrentCustodian(bytes32 batchId, address caller);
    error NotAParticipant(address account);
    error SelfTransfer(bytes32 batchId);
    error InvalidState(bytes32 batchId, BatchStatus current);
    error NotAuthorisedToRecall(bytes32 batchId, address caller);

    // ---------------------------------------------------------- constructor

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGULATOR_ROLE, admin);
    }

    // ------------------------------------------------------------ modifiers

    modifier onlyExisting(bytes32 batchId) {
        if (_batches[batchId].status == BatchStatus.None) {
            revert BatchNotFound(batchId);
        }
        _;
    }

    modifier onlyInState(bytes32 batchId, BatchStatus expected) {
        BatchStatus current = _batches[batchId].status;
        if (current != expected) revert InvalidState(batchId, current);
        _;
    }

    // ------------------------------------------------------- FR1: register

    /// @notice Register a new batch. Only licensed manufacturers may call.
    /// @param batchId      Unique batch identifier (e.g. GS1 code, bytes32).
    /// @param metadataHash keccak256 hash of the off-chain metadata record.
    /// @param productionDate Unix timestamp of production.
    /// @param expiryDate     Unix timestamp of expiry; must be after production.
    function registerBatch(
        bytes32 batchId,
        bytes32 metadataHash,
        uint64 productionDate,
        uint64 expiryDate
    ) external onlyRole(MANUFACTURER_ROLE) whenNotPaused {
        if (_batches[batchId].status != BatchStatus.None) {
            revert BatchAlreadyExists(batchId);
        }
        if (expiryDate <= productionDate || productionDate > block.timestamp) {
            revert InvalidDates(productionDate, expiryDate);
        }

        _batches[batchId] = Batch({
            metadataHash: metadataHash,
            manufacturer: msg.sender,
            currentCustodian: msg.sender,
            productionDate: productionDate,
            expiryDate: expiryDate,
            status: BatchStatus.Active
        });
        _custodyHistory[batchId].push(
            CustodyRecord({
                from: address(0),
                to: msg.sender,
                timestamp: uint64(block.timestamp),
                location: "MANUFACTURING-SITE"
            })
        );

        emit BatchRegistered(
            batchId,
            msg.sender,
            metadataHash,
            productionDate,
            expiryDate
        );
    }

    // ------------------------------------------------------- FR2: transfer

    /// @notice Hand a batch over to the next supply-chain participant.
    ///         Caller must be the current custodian; the recipient must hold
    ///         a participant role (manufacturer, distributor, or pharmacy).
    function transferCustody(
        bytes32 batchId,
        address to,
        string calldata location
    )
        external
        whenNotPaused
        onlyExisting(batchId)
        onlyInState(batchId, BatchStatus.Active)
    {
        Batch storage batch = _batches[batchId];
        if (msg.sender != batch.currentCustodian) {
            revert NotCurrentCustodian(batchId, msg.sender);
        }
        if (to == msg.sender) revert SelfTransfer(batchId);
        if (!isParticipant(to)) revert NotAParticipant(to);
        if (block.timestamp >= batch.expiryDate) {
            revert BatchExpired(batchId, batch.expiryDate);
        }

        batch.currentCustodian = to;
        _custodyHistory[batchId].push(
            CustodyRecord({
                from: msg.sender,
                to: to,
                timestamp: uint64(block.timestamp),
                location: location
            })
        );

        emit CustodyTransferred(batchId, msg.sender, to, location);
    }

    // ------------------------------------------------------- FR3: dispense

    /// @notice A pharmacy that currently holds the batch marks it dispensed.
    ///         Terminal state: no further transfers are possible.
    function dispenseBatch(
        bytes32 batchId
    )
        external
        onlyRole(PHARMACY_ROLE)
        whenNotPaused
        onlyExisting(batchId)
        onlyInState(batchId, BatchStatus.Active)
    {
        Batch storage batch = _batches[batchId];
        if (msg.sender != batch.currentCustodian) {
            revert NotCurrentCustodian(batchId, msg.sender);
        }
        if (block.timestamp >= batch.expiryDate) {
            revert BatchExpired(batchId, batch.expiryDate);
        }

        batch.status = BatchStatus.Dispensed;
        emit BatchDispensed(batchId, msg.sender);
    }

    // --------------------------------------------- quarantine (via oracle)

    /// @notice Suspend a batch after a cold-chain violation. Only callable by
    ///         the ColdChainMonitor contract (cross-contract call).
    function quarantineBatch(
        bytes32 batchId,
        string calldata reason
    )
        external
        onlyRole(MONITOR_ROLE)
        onlyExisting(batchId)
        onlyInState(batchId, BatchStatus.Active)
    {
        _batches[batchId].status = BatchStatus.Quarantined;
        emit BatchQuarantined(batchId, reason);
    }

    /// @notice A regulator may release a quarantined batch after inspection
    ///         (e.g. the excursion was within stability-budget tolerance).
    function releaseBatch(
        bytes32 batchId
    )
        external
        onlyRole(REGULATOR_ROLE)
        onlyExisting(batchId)
        onlyInState(batchId, BatchStatus.Quarantined)
    {
        _batches[batchId].status = BatchStatus.Active;
        emit BatchReleased(batchId, msg.sender);
    }

    // --------------------------------------------------------- FR4: recall

    /// @notice Permanently recall a batch. Allowed for regulators and for the
    ///         manufacturer that registered this specific batch. Works from
    ///         both Active and Quarantined states; terminal thereafter.
    function recallBatch(
        bytes32 batchId,
        string calldata reason
    ) external onlyExisting(batchId) {
        Batch storage batch = _batches[batchId];
        if (
            !hasRole(REGULATOR_ROLE, msg.sender) &&
            msg.sender != batch.manufacturer
        ) {
            revert NotAuthorisedToRecall(batchId, msg.sender);
        }
        if (
            batch.status != BatchStatus.Active &&
            batch.status != BatchStatus.Quarantined
        ) {
            revert InvalidState(batchId, batch.status);
        }

        batch.status = BatchStatus.Recalled;
        emit BatchRecalled(batchId, msg.sender, reason);
    }

    // -------------------------------------------------- global circuit breaker

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------- FR3: views

    /// @notice Point-of-dispensing verification (FR3). `dispensable` folds the
    ///         full business rule into one flag: the batch must exist, be
    ///         Active, and not be past expiry.
    function verifyBatch(
        bytes32 batchId
    )
        external
        view
        onlyExisting(batchId)
        returns (
            BatchStatus status,
            bool dispensable,
            address manufacturer,
            address currentCustodian,
            bytes32 metadataHash,
            uint64 productionDate,
            uint64 expiryDate,
            uint256 transferCount
        )
    {
        Batch storage batch = _batches[batchId];
        status = batch.status;
        dispensable =
            status == BatchStatus.Active &&
            block.timestamp < batch.expiryDate;
        manufacturer = batch.manufacturer;
        currentCustodian = batch.currentCustodian;
        metadataHash = batch.metadataHash;
        productionDate = batch.productionDate;
        expiryDate = batch.expiryDate;
        transferCount = _custodyHistory[batchId].length;
    }

    function getStatus(bytes32 batchId) external view returns (BatchStatus) {
        return _batches[batchId].status;
    }

    function getCustodyHistory(
        bytes32 batchId
    ) external view onlyExisting(batchId) returns (CustodyRecord[] memory) {
        return _custodyHistory[batchId];
    }

    /// @notice True if the account holds any supply-chain participant role.
    function isParticipant(address account) public view returns (bool) {
        return
            hasRole(MANUFACTURER_ROLE, account) ||
            hasRole(DISTRIBUTOR_ROLE, account) ||
            hasRole(PHARMACY_ROLE, account);
    }
}
