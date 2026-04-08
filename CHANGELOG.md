# Changelog

This document summarizes the recent architectural fixes and improvements made to stabilize and optimize the Gemini Extension LSP.

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
