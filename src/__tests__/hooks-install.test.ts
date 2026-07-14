import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  installClaudeStopHook,
  installClaudePostToolUseHook,
  claudeStopHookInstalled,
  claudeHookInstalled,
} from "../cli/hooks-install.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-hooks-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readSettings() {
  const raw = await fs.readFile(path.join(tmpDir, ".claude", "settings.json"), "utf8");
  return JSON.parse(raw);
}

describe("installClaudeStopHook", () => {
  it("creates .claude/settings.json with a Stop hook pointing at auto-memory", async () => {
    const p = await installClaudeStopHook(tmpDir);
    expect(p).toBe(path.join(tmpDir, ".claude", "settings.json"));

    const settings = await readSettings();
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("auto-memory.js");
    expect(cmd).toContain("stop");
    expect(await claudeStopHookInstalled(tmpDir)).toBe(true);
  });

  it("is idempotent — a second run does not add a duplicate group", async () => {
    await installClaudeStopHook(tmpDir);
    await installClaudeStopHook(tmpDir);
    const settings = await readSettings();
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("preserves unrelated hooks and settings", async () => {
    const dir = path.join(tmpDir, ".claude");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "echo other-event" }] }],
        },
      }),
      "utf8",
    );

    await installClaudeStopHook(tmpDir);
    const settings = await readSettings();

    // unrelated top-level key survives
    expect(settings.model).toBe("opus");
    // the other event survives
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    // the unrelated Stop group survives and ours is appended
    expect(settings.hooks.Stop).toHaveLength(2);
    const commands = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    expect(commands).toContain("echo unrelated");
    expect(commands.some((c: string) => c.includes("auto-memory.js"))).toBe(true);
  });

  it("updates our hook in place when re-run after a path change", async () => {
    // seed with an old-style auto-memory hook at a stale path
    const dir = path.join(tmpDir, ".claude");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: 'node "/old/path/auto-memory.js" stop' }] },
          ],
        },
      }),
      "utf8",
    );

    await installClaudeStopHook(tmpDir);
    const settings = await readSettings();
    expect(settings.hooks.Stop).toHaveLength(1); // replaced, not appended
    expect(settings.hooks.Stop[0].hooks[0].command).not.toContain("/old/path/");
  });

  it("claudeStopHookInstalled is false when nothing is configured", async () => {
    expect(await claudeStopHookInstalled(tmpDir)).toBe(false);
  });

  it("installs a PostToolUse hook alongside Stop without collision", async () => {
    await installClaudeStopHook(tmpDir);
    await installClaudePostToolUseHook(tmpDir);
    const settings = await readSettings();

    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(" stop");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(" posttooluse");
    expect(await claudeHookInstalled(tmpDir, "Stop")).toBe(true);
    expect(await claudeHookInstalled(tmpDir, "PostToolUse")).toBe(true);
  });
});
