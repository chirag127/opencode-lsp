# opencode-lsp

Permission-aware language-server tools for **OpenCode V2 / `@opencode/plugin` 2.3.2**.
Runs explicitly configured, separately installed language servers over stdio. MIT licensed.

## Package

- Node.js 22.22.2 or later; portable ESM JavaScript and TypeScript declarations in `dist/`.
- Lazy startup, document synchronization, diagnostics, definition, references, hover and document symbols.
- Tools: `lsp_status`, `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_refresh`, `lsp_shutdown`.
- Each session/agent has its own processes and document cache. File operations recheck `read` and configured-command `shell` permissions.
- Completed `edit`, `write`, `patch` and `shell` calls refresh already-open documents under the same caller's permissions. Use `lsp_refresh` after external edits.

Install server binaries separately and configure their exact executable/argument arrays, roots and extension-to-language mappings. Windows `.cmd`/`.bat` shims are not invoked implicitly; use `node` plus the server's `.js`/`.mjs` entrypoint. Native servers run with host-user authority after command approval; this plugin's real-path checks are not an OS sandbox.

Windows startup requires the matching Koffi native prebuild, installed as a dependency.
Its Job Object owns server descendants through parent exit; a dedicated monitor thread
keeps process waits off the host's filesystem worker pool. POSIX cleanup uses an owned
process group.

## Configure

Install the built plugin tarball in your chosen tools directory with
`npm install --ignore-scripts --omit=dev /path/to/opencode-lsp-0.1.0.tgz`.
Install `typescript-language-server@6.1.0` and `typescript@6.0.3` separately,
then substitute the absolute installed package and server paths below in
`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/tools/node_modules/opencode-lsp",
    "options": {
      "servers": [{
        "id": "typescript",
        "command": ["node", "/absolute/tools/node_modules/typescript-language-server/lib/cli.mjs", "--stdio"],
        "root": ".",
        "extensions": { ".ts": "typescript", ".tsx": "typescriptreact" },
        "initializationOptions": {
          "tsserver": { "path": "/absolute/tools/node_modules/typescript/lib/tsserver.js" },
          "disableAutomaticTypingAcquisition": true
        }
      }],
      "requestTimeoutMs": 20000,
      "diagnosticsTimeoutMs": 20000,
      "shutdownTimeoutMs": 2000
    }
  }]
}
```

On Windows use paths such as `C:/tools/...`. `root` is relative to the active OpenCode
location and must stay inside it; file arguments are location-relative too. No servers
start until a document query passes the caller's permissions. The native top-level
`lsp` setting is not used. No permissions are overwritten or auto-approved.

In Code Mode, discover the `lsp` namespace, then call—for example—
`await tools.lsp.diagnostics({ file: "src/main.ts" })` or
`await tools.lsp.definition({ file: "src/main.ts", line: 1, character: 8 })`.
Positions are zero-based UTF-16. Add `server: "typescript"` when configurations overlap.
Diagnostics with `freshness: "unknown"` do not certify the current revision as clean;
`state: "pending"` means no report arrived before the deadline.

Maintainer canonical notes: `C:/ws/docs/okf/opencode` (workspace-private; not included
in the public package).

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:check
```

`check` runs typechecking, the JavaScript build and synthetic tests, including the pinned TypeScript language server. `pack:check` installs the actual npm tarball in an isolated directory and imports its published entrypoint. Neither uses a live OpenCode session or model.

<footer class="hire-me">
  <h3>Hire me</h3>
  <p>Chirag Singhal — building free, open APIs and tools.</p>
  <p>
    <a href="mailto:chirag@oriz.in">chirag@oriz.in</a> ·
    <a href="https://github.com/chirag127">GitHub</a> ·
    <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> ·
    <a href="https://x.com/singhal127">X</a> ·
    <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> ·
    <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> ·
    <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> ·
    <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a>
  </p>
</footer>
