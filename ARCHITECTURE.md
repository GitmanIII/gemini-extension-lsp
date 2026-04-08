# Gemini Extension LSP - Architecture & Design

This document outlines the high-level architecture and design of the Gemini Extension LSP, an MCP (Model Context Protocol) server designed to connect large language models (like Gemini) to local Language Server Protocol (LSP) backends.

## Overview

The extension acts as a bridge between the MCP standard and the LSP standard. It translates MCP tool invocations into LSP JSON-RPC requests, manages the lifecycles of various language servers, and compresses the potentially massive LSP responses into concise, token-efficient formats suitable for LLMs.

## Fast-Path Architecture

A key design principle is "Fast-Path First." For high-performance development stacks, the extension prioritizes direct CLI-based tools over the heavier Language Server Protocol (LSP) when appropriate for speed.

### 1. `format_and_fix` Fast-Paths
*   **Web (TS/JS/JSX/TSX/JSON/CSS):** Uses **Biome** (`npx @biomejs/biome check --write`) for near-instant formatting and linting.
*   **Python:** Uses **Ruff** (`ruff format` and `ruff check --fix`).
*   **Go:** Uses **Gofmt** (`gofmt -w`).
*   **Rust:** Uses **Rustfmt** (`rustfmt`).
*   **Fallback:** Other languages (C/C++) fall back to the native LSP `textDocument/formatting` request.

### 2. `get_diagnostics` Fast-Paths
*   **Python:** Uses **Ruff** (`ruff check`) for instant results.
*   **Go:** Uses **Go Vet** (`go vet`) for instant results.
*   **Fallback:** Other languages use a polling loop that triggers a `textDocument/didChange` event and waits up to **4 seconds** for the LSP to asynchronously publish diagnostics via a notification.

## Core Components

### 1. `mcpServer.ts` (The Entry Point & Tool Router)
This is the main MCP server implementation. It registers the available tools and determines whether to use a "Fast-Path" CLI tool or a "Slow-Path" LSP request.

**Available Tools:**
*   `getDocumentSymbols`: Fetches and compresses the structural outline of a file.
*   `getWorkspaceSymbols`: Finds a symbol by name across the entire project (vital for navigation).
*   `goToDefinition`: Finds where a specific symbol is defined.
*   `goToImplementation`: Finds the actual code implementing an interface or trait method.
*   `findReferences`: Locates all usages of a symbol across the workspace.
*   `getHoverDocs`: Retrieves documentation or type signatures for a symbol.
*   `renameSymbol`: Safely renames a symbol across the entire workspace.
*   `getCodeActions`: Lists available quick-fixes and refactorings for a code region.
*   `applyCodeAction`: Executes a chosen code action (e.g., "Import missing class").
*   `format_and_fix`: Auto-formats and lints using native tools or the active LSP.
*   `get_diagnostics`: Retrieves cached syntax errors, type errors, and warnings.

### 2. `LspServerManager` (The Orchestrator)
Manages the lifecycle of language server processes for languages requiring the full LSP (e.g., C/C++) and for advanced features (navigation, hover).

*   **Capabilities Negotiation:** During `initialize`, the extension explicitly requests `workspaceEdit`, `rename`, and `codeAction` support from the server to enable advanced refactoring tools.
*   **Dynamic Instantiation:** Reads `~/.gemini/settings.json` to launch configured binaries (e.g., `vtsls`, `gopls`, `clangd`).
*   **Singleton per Extension:** Ensures only one instance runs per extension to save memory.
*   **Synchronization:** Uses an `initializingServers` lock to prevent duplicate process spawns during concurrent requests.
*   **Strict State Management:** Maintains `openedFiles` and `diagnosticsCache` to keep the LSP in a valid state.

### 3. `LspClient.ts` (The JSON-RPC Bridge)
Handles low-level stdin/stdout communication with a single language server child process. It includes robust stream parsing for `Content-Length` headers and handles process termination (via `close` events) to prevent hanging Promises.

## Workspace Edit Middleware
The extension includes a robust `applyWorkspaceEdit` system that can apply complex, multi-file changes suggested by the Language Server. It handles both `changes` (map-based) and `documentChanges` (array-based) formats and includes a `uriToPath` helper for reliable cross-platform file resolution. After applying changes to disk, it automatically sends a `textDocument/didSave` notification to the server to ensure all background analysis (like cross-file type checking) remains in sync.

## Zero-Config Discovery (Smart Fallback)
To ensure the extension works "out of the box" in unconfigured projects, `getWorkspaceSymbols` includes a **Smart Fallback** mechanism. If the Language Server returns no results (often due to restrictive `tsconfig.json` or `pyrightconfig.json` settings), the extension:
1.  Performs a high-speed filesystem scan using `find` and raw text matching.
2.  Forces the Language Server to "Open" and index the matching files.
3.  Re-submits the request to the Language Server, resulting in accurate, project-wide symbol discovery without requiring manual configuration.
