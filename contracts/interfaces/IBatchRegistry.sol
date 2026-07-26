// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBatchRegistry
/// @notice Minimal interface of the batch registry that the cold-chain
///         monitor depends on. Keeping the dependency behind an interface
///         decouples the two contracts and keeps the monitor testable
///         against a mock registry.
interface IBatchRegistry {
    /// @dev Lifecycle of a batch (state-machine pattern).
    ///      None        - batch id has never been registered
    ///      Active      - registered and moving through the supply chain
    ///      Dispensed   - handed to a patient by a pharmacy (terminal)
    ///      Quarantined - suspended by the cold-chain monitor, releasable
    ///      Recalled    - recalled by regulator/manufacturer (terminal)
    enum BatchStatus {
        None,
        Active,
        Dispensed,
        Quarantined,
        Recalled
    }

    function getStatus(bytes32 batchId) external view returns (BatchStatus);

    function quarantineBatch(bytes32 batchId, string calldata reason) external;
}
