import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeProjectRoot, findProjectRoot, nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { projectRootInput } from "./shared.js";

async function loadProjectConfig(projectRoot: string): Promise<Record<string, unknown>> {
  const configPath = path.join(projectRoot, ".ai", "memory-mcp.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // missing or corrupt
  }
  return {};
}

async function saveProjectConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
  const configPath = path.join(projectRoot, ".ai", "memory-mcp.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await fs.rename(tmp, configPath);
}

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "memory_configure_suggestions",
    {
      description: "Update per-project suggestion engine thresholds. Overrides persist in .ai/memory-mcp.json.",
      inputSchema: {
        notifyThreshold: z.number().optional().describe("Minimum score to surface a suggestion (default 3)"),
        autoSaveThreshold: z.number().optional().describe("Minimum score for auto-save (default 5)"),
        autoSaveEnabled: z.boolean().optional().describe("Enable auto-save for high-confidence suggestions"),
        projectRoot: projectRootInput,
      },
    },
    async ({ notifyThreshold, autoSaveThreshold, autoSaveEnabled, projectRoot }) => {
      const root = normalizeProjectRoot(projectRoot) || await findProjectRoot();
      const config = await loadProjectConfig(root);

      const suggestions = (typeof config.suggestions === "object" && config.suggestions !== null)
        ? config.suggestions as Record<string, unknown>
        : {};

      if (notifyThreshold !== undefined) suggestions.notifyThreshold = notifyThreshold;
      if (autoSaveThreshold !== undefined) suggestions.autoSaveThreshold = autoSaveThreshold;
      if (autoSaveEnabled !== undefined) suggestions.autoSaveEnabled = autoSaveEnabled;

      config.suggestions = suggestions;
      config.updatedAt = nowIso();
      await saveProjectConfig(root, config);

      return {
        content: [{ type: "text", text: `Suggestion config updated: ${JSON.stringify(suggestions, null, 2)}` }],
      };
    },
  );
}
