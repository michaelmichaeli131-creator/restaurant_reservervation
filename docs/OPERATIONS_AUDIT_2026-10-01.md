# SpotBook operations audit — 2026-10-01

Baseline: `ae4c8352b4fd998426e89dc2c6d06f9a17fa9973`, branch `feature/mobile-usability-20260926`.
Scope: restaurant ownership and staff authorization, owner inventory/menu/bill handlers, POS HTTP and WebSocket operations, concurrent account/bill updates, inventory counts and attendance.

## Fixed in this change

| Finding | Severity | Reproduction / protection |
|---|---|---|
| Owner role granted access to unrelated restaurants | Critical | Two owners/two restaurants; fix verifies stored restaurant owner. 37 real owner route handlers in inventory, bills and POS reject foreign owners before data access. |
| POS WebSocket allowed anonymous upgrades and arbitrary restaurant subscriptions | Critical | Mock socket executes actual handler source. Old source accepts anonymous and foreign joins; new source rejects them. Per-role permission required; authorization rechecked on live broadcasts and status updates. |
| Item note/status/cancel trusted an authorized restaurant ID without binding the item to it | High | Foreign restaurant's order/item supplied with own restaurant ID; mutation rejected by data layer; HTTP and WebSocket callers supply validated restaurant scope. |
| Cached staff context could survive permission revocation | High | Database membership marked inactive while request context remains active. Access denied; existing live subscriber closed on next matching event. |
| Concurrent account creation created multiple open checks for one table/account | High | Concurrent get-or-create calls now return the same order ID using optimistic checks on account pointers. |
| Concurrent close produced duplicate bills | High | Two closes now create exactly one bill. Order and account-pointer versions checked together. |
| Item arrival during closing could be omitted from the bill | High | Injected item between total calculation and commit. Closure retries and includes the item; closed items cannot be changed. Item mutations participate in order-version checks. |
| Late note/metadata updates could resurrect a closed order | High | Canonical order must remain open and unchanged before updating copied account pointers. |

## Confirmed and still open

1. **Second shift in one day overwrites the first (High).** Isolated attendance sequence 09:00–12:00, 15:00–18:00 reports 180 minutes instead of 360. The data model stores one daily interval. Requires multi-interval handling with compatible payroll, manual editing and UI behavior; not changed by this patch.
2. **Concurrent inventory-count finalization applies adjustments twice (High).** Initial stock 10, count 8, two finalizations yield stock 6. Unlike purchase-order receiving fixed previously, count corrections and final status are still separate writes. Requires an atomic count-finalization transaction and protection against edits during finalization; not changed by this patch.

Reproductions: `tests/known_issues_probe.ts`. This diagnostic reports observed values; it is not a passing regression test for these unresolved defects.

## Validation

- `tests/operations_integrity_test.ts`: ownership, current staff membership, parallel account/close, deterministic item/close interleaving, frozen closed items.
- `tests/owner_route_access_test.ts`: executes 37 real owner handlers with external I/O stubbed and real isolated KV authorization.
- `tests/pos_socket_security_test.ts`: actual socket handler with transport/Oak mocked; anonymous/foreign access, valid kitchen, item scoping, revoked subscriber.
- Prior inventory and reservation-update integration tests passed again.
- Old socket source fails the security regression as expected.
- Clean production patch replay produces byte-identical tested runtime files.

Tests use in-memory KV and fake users/restaurants. No production bookings, bills, emails, stock or attendance records created or edited. No historical data was repaired. This is a targeted audit, not a claim that every restaurant workflow or language is defect-free. Full authenticated UI testing, complete permission-matrix coverage, shift/calendar editing, floor-plan flows and translation review remain outside this round.
