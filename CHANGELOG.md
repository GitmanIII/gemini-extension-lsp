# Changelog

This document summarizes the recent architectural fixes and improvements made to stabilize and optimize the Gemini Extension LSP.

## [0.3.3] - Zero-Config Discovery & Reliability

### Added: Smart Discovery Fallback
*   **Zero-Config Workspace Search**: `getWorkspaceSymbols` now includes a filesystem-scan fallback. If the Language Server fails to find symbols due to missing or restrictive configuration (like `tsconfig.json`), the extension will manually find and "force" the server to index those files.

### Fixed: Synchronization
*   **`applyCodeAction` Sync**: Added a `didSave` notification after executing workspace commands (like "Organize Imports") to ensure the Language Server remains in sync with disk changes.

## [0.3.2] - Workspace Discovery & Sync

### Added: Global Navigation
*   **`getWorkspaceSymbols`**: Added support for searching symbols across the entire project via `workspace/symbol`. This allows the LLM to find where classes/functions are defined without knowing the filename.

### Added: Disk Sync Reliability
*   **`didSave` Notifications**: The extension now explicitly sends `textDocument/didSave` after formatting or renaming. This ensures that background analysis (like cross-file type checking) remains in sync with the filesystem.

## [0.3.1] - Advanced Refactoring Fixes

### Fixed: Refactoring Robustness
*   **Capabilities Negotiation:** Updated the `initialize` handshake to explicitly request `workspaceEdit` and `rename` support. This fixes an issue where strict language servers (like `vtsls`) would silently ignore rename requests.
*   **URI Resolution:** Added a dedicated `uriToPath` helper to accurately translate Language Server URIs into local absolute paths, fixing a bug where renames and quick-fixes were being applied to the wrong directory.

## [0.3.0] - Refactoring & Quick Fixes

### Added: Workspace Edit Support
*   **`applyWorkspaceEdit` Middleware**: The extension can now automatically apply complex, multi-file changes suggested by the Language Server (supporting both `changes` and `documentChanges` formats).

### Added: New Tools
*   **`renameSymbol`**: Safely rename a variable, function, or class across the entire workspace via `textDocument/rename`.
*   **`getCodeActions` & `applyCodeAction`**: Support for "Quick Fixes" and advanced refactorings (e.g., "Import missing class" or "Extract method").
*   **`goToImplementation`**: Jump to concrete code implementations of interfaces/traits.

## [0.2.1] - Robustness & Error Handling

### Added: LSP Lifecycle Improvements
*   **Process Error Handling:** `LspClient.ts` now catches `error` events (like `ENOENT` spawn failures) and correctly rejects pending promises.

### Changed: Diagnostic Reliability
*   **Extended Polling Timeout:** Increased `get_diagnostics` fallback polling from 4s to 10s to properly support heavier language servers. (Note: Later reverted to 4s based on user performance feedback).

## [0.2.0] - Optimization & Performance Pivot

### Added: Fast-Path Optimizations
*   **Gofmt Fast-Path:** Added direct `gofmt` support for Go formatting.
*   **Rustfmt Fast-Path:** Added direct `rustfmt` support for Rust formatting.
*   **Ruff/GoVet Diagnostics:** `get_diagnostics` now uses `ruff check` and `go vet` for near-instant feedback.
*   **Biome Integration:** Full instant linting and formatting for the TypeScript/JavaScript ecosystem.

### Changed: Streamlined Language Support
*   **Focused Core:** Dropped support for several heavy or obscure languages to prioritize speed and reliability for modern stacks. Removed: `.cs`, `.java`, `.php`, `.swift`, `.kt`, `.kts`, `.lua`, `.rb`.
*   **Architecture Update:** Shifted the design philosophy to "Fast-Path First" for common operations.

## [0.1.0] - Stability & Bug Fixes

### Fixed: Core LSP Reliability
*   **Robust Header Parsing:** Updated `LspClient.ts` to handle multiple headers and mid-buffer messages correctly.
*   **LSP State Management:** Implemented an `openedFiles` tracker to ensure `textDocument/didOpen` is only sent once per file.
*   **Concurrency Fixes:** Added an `initializingServers` lock to prevent duplicate LSP spawns when multiple tools are called at once.
*   **Deadlock Prevention:** Pending promises are now automatically rejected if an LSP child process terminates unexpectedly.
*   **LSP Language IDs:** Added explicit mapping from extensions to registered LSP identifiers (e.g., `.ts` -> `typescript`).
