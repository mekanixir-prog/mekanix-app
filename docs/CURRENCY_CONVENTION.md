# Currency Convention

## Core marketplace accounting

The core MEKANIX marketplace uses **USD as its canonical accounting unit** for:
- technician hourly rates and service prices;
- invoices and invoice payments;
- VIP plan prices;
- technician wallet balances, earnings, commissions, withdrawals, and ledger entries.

Persist these values as USD base amounts. Do not multiply or divide them when writing invoices, payments, wallets, or ledger entries.

The Persian UI converts USD values to Iranian Rial for display through the shared USD → IRR rate service. The English UI may display the selected display currency, but the stored amount remains USD.

## Gateway boundary

A Shaparak-compatible gateway expects an IRR amount. A gateway attempt therefore stores:
- `PaymentGatewayLog.amount`: the converted amount sent to the gateway, in IRR;
- `PaymentGatewayLog.currency`: `IRR` for new gateway attempts;
- `PaymentGatewayLog.baseAmountUsd`: the original order amount, in USD;
- `PaymentGatewayLog.exchangeRate`: the locked USD → IRR rate used for that attempt.

A successful verification creates a `Payment` in USD from `baseAmountUsd`. Never reinterpret a gateway IRR amount as a USD payment amount. If the locked USD amount is missing, the verification route returns a reconciliation-required conflict instead of guessing.

The current gateway initiation and verification routes are development simulators and remain blocked in production. A real provider integration must resolve the amount from the server-side invoice/plan, use the locked IRR amount for provider verification, and preserve the USD base amount for internal accounting.

## Legacy normalization

The previous simulator wrote USD values into fields labelled `IRR`. The canonical-currency migration:
- relabels existing invoice and payment rows as USD without changing their numeric amounts;
- renames VIP plan `priceIrr` to `priceUsd`;
- preserves old simulator gateway logs by copying their prior amount into `baseAmountUsd`, recording an exchange rate of 1, and labelling those legacy log amounts USD;
- records the converted IRR amount and locked FX rate for new gateway attempts.

This is based on the existing seed data and pricing flow, where technician rates, VIP plan prices, wallet values, and invoice totals are USD base values.

## MEKANIX CARE boundary

The separate MEKANIX CARE pricing engine currently declares and calculates its `PricingSnapshot` values in IRR. Do not mix CARE snapshot values with core marketplace USD wallet or invoice amounts. A future CARE currency migration must update its pricing engine, package prices, snapshots, and reports together, with an explicit conversion/data migration plan.
