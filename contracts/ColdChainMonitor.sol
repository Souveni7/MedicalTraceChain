// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBatchRegistry} from "./interfaces/IBatchRegistry.sol";

/// @title ColdChainMonitor
/// @notice On-chain half of the cold-chain oracle (FR5). An off-chain oracle
///         node aggregates raw IoT sensor readings (which stay off-chain) and
///         submits one summarised reading per interval. This contract holds
///         the business logic: it checks the reading against the batch's
///         temperature envelope, counts excursions, and once the excursion
///         limit is reached it automatically quarantines the batch in the
///         BatchRegistry via a cross-contract call.
///
///         Applied design patterns:
///         - Oracle: only the authorised oracle node (ORACLE_ROLE) can inject
///           real-world data; raw sensor streams stay off-chain, the chain
///           stores only the latest summary and violation counters.
///         - Access Restriction / RBAC: oracle and admin roles.
///         - Threshold / tolerance logic: an excursion limit implements a
///           simple stability budget rather than punishing a single blip.
contract ColdChainMonitor is AccessControl {
    // ---------------------------------------------------------------- roles

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // ---------------------------------------------------------------- types

    /// @dev Temperatures are fixed-point centi-degrees Celsius (250 = 2.50 C)
    ///      because the EVM has no floating point.
    struct Threshold {
        int16 minCenti;
        int16 maxCenti;
        uint8 excursionLimit; // quarantine after this many excursions
        bool overridden; // false = batch uses the default envelope
    }

    struct MonitorState {
        uint32 readingCount;
        uint32 excursionCount;
        int16 lastTempCenti;
        uint64 lastTimestamp;
        bool quarantineTriggered;
    }

    // -------------------------------------------------------------- storage

    IBatchRegistry public immutable registry;

    /// @dev Default envelope: 2.00 C .. 8.00 C, quarantine on 1st excursion.
    ///      WHO-recommended range for most refrigerated vaccines.
    int16 public constant DEFAULT_MIN_CENTI = 200;
    int16 public constant DEFAULT_MAX_CENTI = 800;
    uint8 public constant DEFAULT_EXCURSION_LIMIT = 1;

    /// @dev Sanity bounds for sensor data: -40.00 C .. 85.00 C (typical
    ///      operating range of cold-chain sensors). Anything outside is a
    ///      sensor fault, not a reading.
    int16 public constant SENSOR_MIN_CENTI = -4000;
    int16 public constant SENSOR_MAX_CENTI = 8500;

    mapping(bytes32 => Threshold) private _thresholds;
    mapping(bytes32 => MonitorState) private _states;

    // --------------------------------------------------------------- events

    event ThresholdSet(
        bytes32 indexed batchId,
        int16 minCenti,
        int16 maxCenti,
        uint8 excursionLimit
    );
    event ReadingRecorded(
        bytes32 indexed batchId,
        int16 tempCenti,
        uint64 timestamp
    );
    event TemperatureExcursion(
        bytes32 indexed batchId,
        int16 tempCenti,
        int16 minCenti,
        int16 maxCenti,
        uint32 excursionCount
    );
    event QuarantineTriggered(bytes32 indexed batchId, int16 tempCenti);

    // --------------------------------------------------------------- errors

    error InvalidThreshold(int16 minCenti, int16 maxCenti);
    error InvalidReading(int16 tempCenti);
    error StaleReading(uint64 provided, uint64 lastSeen);
    error FutureReading(uint64 provided, uint64 blockTime);
    error BatchNotActive(bytes32 batchId);

    // ---------------------------------------------------------- constructor

    constructor(IBatchRegistry registry_, address admin) {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ----------------------------------------------------------- thresholds

    /// @notice Override the temperature envelope for a specific batch, e.g.
    ///         frozen products (-25 C .. -15 C) or a stricter biologic.
    function setThreshold(
        bytes32 batchId,
        int16 minCenti,
        int16 maxCenti,
        uint8 excursionLimit
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minCenti >= maxCenti || excursionLimit == 0) {
            revert InvalidThreshold(minCenti, maxCenti);
        }
        _thresholds[batchId] = Threshold({
            minCenti: minCenti,
            maxCenti: maxCenti,
            excursionLimit: excursionLimit,
            overridden: true
        });
        emit ThresholdSet(batchId, minCenti, maxCenti, excursionLimit);
    }

    // ------------------------------------------------------ oracle ingress

    /// @notice Submit one aggregated sensor reading for a batch. Only the
    ///         authorised oracle node may call. Reverts for batches that are
    ///         not Active so the oracle stops tracking finished batches.
    function reportReading(
        bytes32 batchId,
        int16 tempCenti,
        uint64 timestamp
    ) external onlyRole(ORACLE_ROLE) {
        // -- validate the reading itself
        if (tempCenti < SENSOR_MIN_CENTI || tempCenti > SENSOR_MAX_CENTI) {
            revert InvalidReading(tempCenti);
        }
        MonitorState storage state = _states[batchId];
        if (timestamp <= state.lastTimestamp) {
            revert StaleReading(timestamp, state.lastTimestamp);
        }
        // allow modest clock skew between sensor and chain (5 minutes)
        if (timestamp > block.timestamp + 5 minutes) {
            revert FutureReading(timestamp, uint64(block.timestamp));
        }
        if (registry.getStatus(batchId) != IBatchRegistry.BatchStatus.Active) {
            revert BatchNotActive(batchId);
        }

        // -- record (checks-effects-interactions: all state updates precede
        //    the external quarantine call below)
        state.readingCount += 1;
        state.lastTempCenti = tempCenti;
        state.lastTimestamp = timestamp;

        (int16 minC, int16 maxC, uint8 limit) = _envelopeOf(batchId);

        if (tempCenti < minC || tempCenti > maxC) {
            state.excursionCount += 1;
            emit TemperatureExcursion(
                batchId,
                tempCenti,
                minC,
                maxC,
                state.excursionCount
            );
            if (
                state.excursionCount >= limit && !state.quarantineTriggered
            ) {
                state.quarantineTriggered = true;
                emit QuarantineTriggered(batchId, tempCenti);
                registry.quarantineBatch(
                    batchId,
                    "Cold-chain temperature excursion limit reached"
                );
            }
        } else {
            emit ReadingRecorded(batchId, tempCenti, timestamp);
        }
    }

    // ---------------------------------------------------------------- views

    function getThreshold(
        bytes32 batchId
    )
        external
        view
        returns (int16 minCenti, int16 maxCenti, uint8 excursionLimit)
    {
        return _envelopeOf(batchId);
    }

    function getMonitorState(
        bytes32 batchId
    ) external view returns (MonitorState memory) {
        return _states[batchId];
    }

    // ------------------------------------------------------------ internals

    function _envelopeOf(
        bytes32 batchId
    ) private view returns (int16, int16, uint8) {
        Threshold storage t = _thresholds[batchId];
        if (t.overridden) return (t.minCenti, t.maxCenti, t.excursionLimit);
        return (DEFAULT_MIN_CENTI, DEFAULT_MAX_CENTI, DEFAULT_EXCURSION_LIMIT);
    }
}
