// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

/// @title CollateralVault
/// @notice Holds user collateral on-chain while application-specific actions execute off-chain.
/// @dev The reference implementation trusts a backend/operator address to approve withdrawals and submit settlements.
contract CollateralVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InvalidAmount();
    error NotOperator(address caller);
    error InsufficientBalance(uint256 available, uint256 requested);
    error InsufficientPendingWithdrawal(uint256 pending, uint256 requested);
    error InsufficientApprovedWithdrawal(uint256 approved, uint256 requested);
    error InsufficientVaultLiquidity(uint256 tokenBalance, uint256 requiredAccountingBalance);
    error InsufficientInsuranceBalance(uint256 available, uint256 requested);
    error SettlementAlreadyUsed(bytes32 settlementId);

    IERC20 public immutable collateralToken;
    address public operator;
    uint256 public totalLiabilities;
    uint256 public insuranceBalance;

    mapping(address user => uint256 balance) private balances;
    mapping(address user => uint256 amount) public pendingWithdrawals;
    mapping(address user => uint256 amount) public approvedWithdrawals;
    mapping(bytes32 settlementId => bool used) public usedSettlements;

    event Deposited(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 amount);
    event WithdrawApproved(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event InsuranceFunded(address indexed funder, uint256 amount);
    event InsuranceUsed(address indexed user, uint256 amount);
    event SettlementApplied(
        address indexed user,
        int256 amountDelta,
        uint256 newBalance,
        bytes32 indexed settlementId,
        bytes32 reasonHash
    );
    /// @notice Legacy event kept for compatibility with earlier trading-oriented integrations.
    event PnlSettled(
        address indexed user,
        int256 pnl,
        uint256 newBalance,
        bytes32 indexed settlementId,
        bytes32 reasonHash
    );
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    constructor(IERC20 collateralToken_, address operator_) Ownable(msg.sender) {
        if (address(collateralToken_) == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }

        collateralToken = collateralToken_;
        operator = operator_;
    }

    /// @notice Updates the trusted backend/operator address.
    /// @param newOperator New operator address allowed to approve withdrawals and apply settlements.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();

        address previousOperator = operator;
        operator = newOperator;

        emit OperatorUpdated(previousOperator, newOperator);
    }

    /// @notice Deposits collateral into the vault after the user approves this contract.
    /// @param amount Amount in the collateral token smallest units, e.g. micro-USDC for MockUSDC.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);

        balances[msg.sender] += amount;
        totalLiabilities += amount;
        _assertSolvent();

        emit Deposited(msg.sender, amount);
    }

    /// @notice Funds protocol-owned insurance liquidity used to pay positive user settlements.
    /// @param amount Amount in the collateral token smallest units.
    function fundInsurance(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        insuranceBalance += amount;
        _assertSolvent();

        emit InsuranceFunded(msg.sender, amount);
    }

    /// @notice Requests a withdrawal. Funds are not transferable until the operator approves it.
    /// @param amount Amount in the collateral token smallest units.
    function requestWithdraw(uint256 amount) external nonReentrant {
        _requestWithdraw(msg.sender, amount);
    }

    /// @notice Operator-assisted withdrawal request for API/demo flows.
    /// @dev Users can still call requestWithdraw directly from a wallet.
    function requestWithdrawFor(address user, uint256 amount) external onlyOperator nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        _requestWithdraw(user, amount);
    }

    /// @notice Approves a pending withdrawal after the off-chain risk checks pass.
    /// @param user User whose withdrawal is being approved.
    /// @param amount Amount in the collateral token smallest units.
    function approveWithdraw(address user, uint256 amount) external onlyOperator nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 pending = pendingWithdrawals[user];
        if (pending < amount) revert InsufficientPendingWithdrawal(pending, amount);

        uint256 alreadyApproved = approvedWithdrawals[user];
        uint256 balance = balances[user];
        uint256 availableForApproval = balance > alreadyApproved ? balance - alreadyApproved : 0;
        if (availableForApproval < amount) revert InsufficientBalance(availableForApproval, amount);

        pendingWithdrawals[user] = pending - amount;
        approvedWithdrawals[user] = alreadyApproved + amount;

        emit WithdrawApproved(user, amount);
    }

    /// @notice Backward-compatible withdrawal entry point restricted by approvedWithdrawals.
    /// @dev Direct withdraws can no longer bypass backend/operator approval.
    function withdraw(uint256 amount) external nonReentrant {
        _withdrawApproved(msg.sender, amount);
    }

    /// @notice Withdraws collateral previously approved by the operator.
    /// @param amount Amount in the collateral token smallest units.
    function withdrawApproved(uint256 amount) external nonReentrant {
        _withdrawApproved(msg.sender, amount);
    }

    /// @notice Applies a generic off-chain settlement delta to a user's vault balance.
    /// @dev Positive deltas consume insurance liquidity; negative deltas move user balance into insurance.
    /// @param user User whose collateral balance will be adjusted.
    /// @param amountDelta Signed balance delta in the collateral token smallest units.
    /// @param settlementId Unique settlement identifier generated by the backend/operator.
    /// @param reasonHash Hash of the off-chain settlement context used by the operator.
    function settle(
        address user,
        int256 amountDelta,
        bytes32 settlementId,
        bytes32 reasonHash
    ) external onlyOperator nonReentrant {
        uint256 newBalance = _applySettlement(user, amountDelta, settlementId);
        emit SettlementApplied(user, amountDelta, newBalance, settlementId, reasonHash);
    }

    /// @notice Legacy trading-oriented settlement alias.
    /// @dev Kept for compatibility. New integrations should call settle(...).
    function settlePnl(
        address user,
        int256 pnl,
        bytes32 settlementId,
        bytes32 reasonHash
    ) external onlyOperator nonReentrant {
        uint256 newBalance = _applySettlement(user, pnl, settlementId);
        emit SettlementApplied(user, pnl, newBalance, settlementId, reasonHash);
        emit PnlSettled(user, pnl, newBalance, settlementId, reasonHash);
    }

    /// @notice Returns the recorded collateral balance for a user.
    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }

    function _requestWithdraw(address user, uint256 amount) private {
        if (amount == 0) revert InvalidAmount();

        uint256 reserved = pendingWithdrawals[user] + approvedWithdrawals[user];
        uint256 balance = balances[user];
        uint256 availableForRequest = balance > reserved ? balance - reserved : 0;
        if (availableForRequest < amount) revert InsufficientBalance(availableForRequest, amount);

        pendingWithdrawals[user] += amount;

        emit WithdrawRequested(user, amount);
    }

    function _withdrawApproved(address user, uint256 amount) private {
        if (amount == 0) revert InvalidAmount();

        uint256 approved = approvedWithdrawals[user];
        if (approved < amount) revert InsufficientApprovedWithdrawal(approved, amount);

        uint256 currentBalance = balances[user];
        if (currentBalance < amount) revert InsufficientBalance(currentBalance, amount);

        approvedWithdrawals[user] = approved - amount;
        balances[user] = currentBalance - amount;
        totalLiabilities -= amount;

        collateralToken.safeTransfer(user, amount);
        _assertSolvent();

        emit Withdrawn(user, amount);
    }

    function _applySettlement(
        address user,
        int256 amountDelta,
        bytes32 settlementId
    ) private returns (uint256 newBalance) {
        if (user == address(0)) revert ZeroAddress();
        if (usedSettlements[settlementId]) revert SettlementAlreadyUsed(settlementId);

        usedSettlements[settlementId] = true;

        if (amountDelta > 0) {
            uint256 delta = uint256(amountDelta);
            if (insuranceBalance < delta)
                revert InsufficientInsuranceBalance(insuranceBalance, delta);

            insuranceBalance -= delta;
            newBalance = balances[user] + delta;
            balances[user] = newBalance;
            totalLiabilities += delta;

            emit InsuranceUsed(user, delta);
        } else if (amountDelta < 0) {
            uint256 delta = uint256(-amountDelta);
            uint256 currentBalance = balances[user];
            if (currentBalance < delta) revert InsufficientBalance(currentBalance, delta);

            newBalance = currentBalance - delta;
            balances[user] = newBalance;
            totalLiabilities -= delta;
            insuranceBalance += delta;
        } else {
            newBalance = balances[user];
        }

        _assertSolvent();
    }

    function _assertSolvent() private view {
        uint256 tokenBalance = collateralToken.balanceOf(address(this));
        uint256 requiredAccountingBalance = totalLiabilities + insuranceBalance;
        if (tokenBalance < requiredAccountingBalance) {
            revert InsufficientVaultLiquidity(tokenBalance, requiredAccountingBalance);
        }
    }
}
