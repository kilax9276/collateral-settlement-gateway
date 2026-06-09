# Use Cases

Collateral Settlement Gateway is useful wherever an application needs fast off-chain logic while keeping collateral and final settlement anchored on-chain.

## Trading competitions

Users deposit collateral, submit signed trading actions, and receive final results through audited on-chain settlement. The included trading reference application demonstrates this pattern.

## Prediction markets

Users sign participation intents off-chain. A resolver app submits outcome-based settlements linked to signed intents and public references.

## Collateralized games

A game server runs fast gameplay logic off-chain while deposits, rewards, and withdrawals are controlled through the Vault and audit reports.

## Reward systems

An external app can reward users for verified actions by submitting app-authorized settlement requests linked to signed user intents.

## Risk simulations

Teams can model financial workflows, settlement reports, and reconciliation without building a custody and gateway stack from zero.

## Derivatives and structured products experiments

The gateway pattern can support early-stage experimentation with margin, collateral, and settlement flows while making clear that production systems need deeper risk engines, audits, oracle policy, and regulatory review.
