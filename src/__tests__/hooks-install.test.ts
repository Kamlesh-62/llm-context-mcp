import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  installClaudeStopHook,
  installClaudePostToolUseHook,
  claudeStopHookInstalled,
  claudeHookInstalled,
  installCodexPostToolUseHook,
  codexPostToolUseHookInstalled,
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

describe("installCodexPostToolUseHook", () => {
  let tmpDir: string;
  let codexHome: string;
  let savedCodexHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-codex-"));
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome; // keep the real ~/.codex untouched
  });

  afterEach(async () => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("writes .codex/hooks.json with a posttooluse command and enables the flag", async () => {
    const r = await installCodexPostToolUseHook(tmpDir);
    expect(r.featureFlag).toBe("added");

    const doc = JSON.parse(await fs.readFile(path.join(tmpDir, ".codex", "hooks.json"), "utf8"));
    expect(doc.PostToolUse[0].hooks[0].command).toContain("auto-memory.js");
    expect(doc.PostToolUse[0].hooks[0].command).toContain("posttooluse");

    const toml = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(toml).toMatch(/\[features\]/);
    expect(toml).toMatch(/hooks\s*=\s*true/);

    expect(await codexPostToolUseHookInstalled(tmpDir)).toBe(true);
  });

  it("is idempotent and reports the flag already present", async () => {
    await installCodexPostToolUseHook(tmpDir);
    const r2 = await installCodexPostToolUseHook(tmpDir);
    expect(r2.featureFlag).toBe("present");
    const doc = JSON.parse(await fs.readFile(path.join(tmpDir, ".codex", "hooks.json"), "utf8"));
    expect(doc.PostToolUse).toHaveLength(1); // no duplicate
  });

  it("does not edit an existing [features] table (reports manual)", async () => {
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      '[features]\nweb_search = true\n',
      "utf8",
    );
    const r = await installCodexPostToolUseHook(tmpDir);
    expect(r.featureFlag).toBe("manual");
    const toml = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(toml).not.toMatch(/hooks\s*=\s*true/); // left untouched
  });
});
