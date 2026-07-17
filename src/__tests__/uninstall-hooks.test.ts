import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runUninstallHooks } from "../cli/uninstall-hooks.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-hooks-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeClaude(settings: unknown): Promise<string> {
  const p = path.join(dir, ".claude", "settings.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(settings, null, 2));
  return p;
}

describe("runUninstallHooks (Claude)", () => {
  it("removes our hook groups but preserves unrelated hooks", async () => {
    const p = await writeClaude({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: 'node "/x/dist/hooks/auto-memory.js" stop' }] },
          { hooks: [{ type: "command", command: "echo keep-me" }] },
        ],
        PostToolUse: [
          { hooks: [{ type: "command", command: 'node "/x/dist/hooks/auto-memory.js" posttooluse' }] },
        ],
      },
      other: true,
    });

    await runUninstallHooks(["--cli", "claude", "--project", dir]);

    const after = JSON.parse(await fs.readFile(p, "utf8"));
    // Unrelated Stop hook survives; our two groups are gone.
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toContain("keep-me");
    // PostToolUse emptied entirely -> key removed.
    expect(after.hooks.PostToolUse).toBeUndefined();
    // Non-hook config untouched.
    expect(after.other).toBe(true);
  });

  it("drops the hooks key when nothing is left after removal", async () => {
    const p = await writeClaude({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: 'node "/x/dist/hooks/auto-memory.js" stop' }] },
        ],
      },
    });

    await runUninstallHooks(["--cli", "claude", "--project", dir]);

    const after = JSON.parse(await fs.readFile(p, "utf8"));
    expect(after.hooks).toBeUndefined();
  });

  it("is a no-op when no auto-memory hooks are present", async () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
    const p = await writeClaude(original);

    await runUninstallHooks(["--cli", "claude", "--project", dir]);

    const after = JSON.parse(await fs.readFile(p, "utf8"));
    expect(after).toEqual(original);
  });
});
