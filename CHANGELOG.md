# Changelog

This document summarizes the recent architectural fixes and improvements made to stabilize and optimize the Gemini Extension LSP.

## [0.2.0] - Optimization & Performance Pivot

### Added: Fast-Path Optimizations
*   **Gofmt Fast-Path:** Added direct `gofmt` support for Go formatting, bypassing the slower `gopls` formatting request.
*   **Rustfmt Fast-Path:** Added direct `rustfmt` support for Rust formatting.
*   **Ruff/GoVet Diagnostics:** `get_diagnostics` now uses `ruff check` and `go vet` for near-instant feedback, avoiding the LSP polling loop.
*   **Biome Integration:** Full instant linting and formatting for the TypeScript/JavaScript ecosystem.

### Changed: Streamlined Language Support
*   **Focused Core:** Dropped support for several heavy or obscure languages to prioritize speed and reliability for modern stacks. Removed: `.java`, `.php`, `.swift`, `.kt`, `.kts`, `.lua`, `.rb`.
*   **Architecture Update:** Shifted the design philosophy to "Fast-Path First" for common operations.

## [0.1.0] - Stability & Bug Fixes

### Fixed: Core LSP Reliability
*   **Robust Header Parsing:** Updated `LspClient.ts` to handle multiple headers and mid-buffer messages correctly.
*   **LSP State Management:** Implemented an `openedFiles` tracker to ensure `textDocument/didOpen` is only sent once per file.
*   **Concurrency Fixes:** Added an `initializingServers` lock to prevent duplicate LSP spawns when multiple tools are called at once.
*   **Deadlock Prevention:** Pending promises are now automatically rejected if an LSP child process terminates unexpectedly.
*   **LSP Language IDs:** Added explicit mapping from extensions to registered LSP identifiers (e.g., `.ts` -> `typescript`).
