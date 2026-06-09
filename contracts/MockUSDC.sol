// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

/// @title MockUSDC
/// @notice Demo ERC-20 token used as local collateral for the Collateral Settlement Gateway local demo.
/// @dev This is not production USDC. It intentionally exposes owner-only minting for demos/tests.
contract MockUSDC is ERC20, Ownable {
    constructor() ERC20('Mock USDC', 'mUSDC') Ownable(msg.sender) {}

    /// @notice USDC-compatible decimal precision.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints demo tokens to an address. Restricted to the owner.
    /// @param to Token recipient.
    /// @param amount Amount in micro-USDC units, e.g. 1 USDC = 1_000_000.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
