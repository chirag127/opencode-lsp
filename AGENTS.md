# OpenCode language servers

This repository owns permission-aware stdio language-server lifecycle, saved-document synchronization, diagnostics and navigation over public OpenCode 2.3.2 and LSP/JSON-RPC contracts. Server commands and binaries must be explicitly configured. Preserve caller/session/agent isolation, read and command permissions, path/alias revalidation, cancellation and process ownership.

## Development and verification

- Use the pinned dependency lockfile and Node 22.22.2 or later. Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check`, and `npm run pack:check` from this repository.
- Tests use synthetic files and an explicitly installed TypeScript language server. Verify the installed tarball with development dependencies omitted and imports confined to its consumer. Do not use live user sessions or external inference for regression fixtures.
- Raw after-write metadata must satisfy the published JSON contract. Omit absent optional diagnostic fields and retain populated values. Distinguish pending reports and unversioned unknown freshness from a current clean revision.
- Windows process ownership uses kill-on-close Job Objects and a dedicated monitor Worker; persistent waits must not starve the shared libuv pool. Preserve retryable ownership after partial-start cleanup failures. Verify descendant exit as well as the direct server.
- Preserve the MIT license and exclude generated consumers, dependencies, databases and temporary fixtures from Git. The package does not bundle or install production language servers.

## Maintainer workspace

Canonical detailed documentation and continuation state are workspace-private at `C:/ws/docs/okf/opencode`, including `tasks/feature-parity-20261121.md`. Do not copy that knowledge base into this repository. Public setup is self-contained in README.md.

In the maintainer workspace, this project is registered at `repos/own/public/libraries/opencode-lsp`. Follow `C:/ws/AGENTS.md` and its autonomous-coding policy when available. Concurrent workers retain exclusive scopes; the integration owner alone changes shared configuration, Git integration and canonical notes. Preserve existing worktrees and unrelated work. The deliberately removed protocol reference checkout must not be recreated.
