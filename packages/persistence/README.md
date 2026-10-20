# @scriptorium-atlas/persistence

Host-owned IndexedDB storage and deterministic Atlas Board serialization for the Atlas V1 standalone host.

## Host adapter

`@scriptorium-atlas/persistence/host` exports `openIndexedDbHost()` and the local-only `IndexedDbHostPort` types. It opens `scriptorium-atlas-v1` with the four V1 stores (`workspaces`, `files`, `journal`, and `receipts`), requires strict-durability write transactions, and owns review drafts, atomic commits, receipts, recovery, and workspace bundles. Keep this adapter on the Host side; plugin frames receive only the contract `HostPort` surface.

## Board files

`@scriptorium-atlas/persistence/board` exports `serializeBoard(board, original?)`. It validates the canonical Board contract and relationships, emits stable UTF-8 JSON with a terminal LF, and returns the original content exactly when the Board has no semantic changes.

## Byte helpers

`@scriptorium-atlas/persistence/bytes` exports the storage implementation's SHA-256, UTF-8, base64, and stable JSON helpers for Host components that need the same byte rules.

Run `npm run typecheck` and `npm test` from this package for its static and unit checks. `npm run test:browser` builds the package and exercises SVG classification with Chromium through Playwright.
