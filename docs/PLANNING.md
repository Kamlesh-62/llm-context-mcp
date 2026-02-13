## Custom Server Naming & Multi-Runner Switching – Planning Draft

> Note: Unable to create a new Git branch (`feature/custom-server-name`) because the sandbox blocks writes inside `.git/refs` (`Operation not permitted` when creating lock files). All planning work is happening on `master` until permissions are resolved.

### Goals
- **Prompt for server ID** during `project-memory-mcp setup` instead of silently defaulting to `"project-memory"`.
- **Support multiple MCP server registrations** so users can run both a global `npx` instance and a local checkout, and switch between them.
- **Document switching guidance** in README/LOCAL_SETUP, covering renaming existing entries and toggling between installs.

### Proposed Technical Approach
1. **Config refactor**
   - Replace `CONFIG.serverName` constant / `SERVER_ID` usage with a dynamic value supplied at runtime (either via CLI flag `--server-id` or interactive prompt).
   - Persist chosen server ID in a small JSON file inside the project (e.g., `.ai/memory.config.json`) or re-derive it from CLI configs.
   - Update all MCP registration commands (`claude`, `gemini`, `codex`) to use the user-provided ID.

2. **Setup wizard UX**
   - Add a prompt step: “What should this server be called inside your CLI? (letters, digits, dashes)”.
   - Validate uniqueness (warn if same ID already exists, offer overwrite or new name).
   - Accept `--server-id <name>` flag for scripted installs.

3. **Runner switching**
   - Allow multiple saved runner presets (e.g., `npx`, `global`, `local-path`).
   - Provide an option in the wizard (or a new command `project-memory-mcp switch`) to update existing CLI configs to a different runner without rewriting every other setting.
   - Document how to run `gemini mcp remove/add <id> ...` and `codex mcp remove/add <id> ...` manually if users maintain two installs.

4. **Docs & examples**
   - README: new “Custom server names & multi-install switching” section with sample commands.
   - `docs/LOCAL_SETUP.md`: detailed steps for registering multiple MCP servers (e.g., `project-memory-npx`, `project-memory-local`) and how to swap via CLI commands or the wizard.
   - Mention new CLI flags in both docs.

5. **Versioning & release**
   - Target `v0.2.0` to capture the breaking change (no more implicit `project-memory` ID).
   - Update changelog / release notes to instruct existing users to rerun setup or rename their entries.

### Open Questions / Follow-ups
- Where should we persist the chosen server ID for subsequent CLI runs? (env var, config file, CLI arguments?)
- Do we need migration logic for users who already have `"project-memory"` registered to avoid duplicate entries?
- Should the wizard offer to update existing entries in-place vs. creating brand-new names per CLI?

### Next Steps
1. Confirm approach for storing server ID (design doc / decision).
2. Implement CLI flag + prompt in `src/setup.ts`, updating wizard steps and help output.
3. Refactor runtime config references to use the dynamic ID.
4. Extend README + LOCAL_SETUP with switching instructions.
5. Bump version (`npm version minor`) and publish once code changes + docs are merged.
