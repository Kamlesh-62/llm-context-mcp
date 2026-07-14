import fs from "node:fs/promises";
import path from "node:path";

import { findProjectRoot } from "../runtime.js";
import { getBackend } from "../storage.js";
import { storePathFor } from "../storage/config.js";
import type { BackendKind } from "../storage/backend.js";
import type { Store } from "../types.js";

type MigrateArgs = {
  to?: BackendKind;
  from?: BackendKind;
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  setDefault: boolean;
};

function parseBackend(value: string | undefined): BackendKind | undefined {
  if (value === "json" || value === "sqlite") return value;
  return undefined;
}

function parseArgs(argv: string[]): MigrateArgs | { error: string } {
  const args: MigrateArgs = {
    projectRoot: "",
    dryRun: false,
    force: false,
    setDefault: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to" && argv[i + 1]) {
      const b = parseBackend(argv[++i]);
      if (!b) return { error: `Invalid --to value (expected json|sqlite)` };
      args.to = b;
    } else if (a === "--from" && argv[i + 1]) {
      const b = parseBackend(argv[++i]);
      if (!b) return { error: `Invalid --from value (expected json|sqlite)` };
      args.from = b;
    } else if ((a === "--project" || a === "-p") && argv[i + 1]) {
      args.projectRoot = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--set-default") {
      args.setDefault = true;
    }
  }
  return args;
}

/** Load a store from a specific backend without mutating it (read-only). */
async function loadFrom(backend: BackendKind, projectRoot: string): Promise<Store> {
  const memoryFilePath = storePathFor(backend, projectRoot);
  const session = await getBackend(backend).begin({ projectRoot, memoryFilePath });
  try {
    return structuredClone(session.store);
  } finally {
    await session.release();
  }
}

type SaveResult = { items: number; proposals: number; revision: number };

/** Copy a store's contents into a target backend. */
async function saveInto(
  backend: BackendKind,
  projectRoot: string,
  source: Store,
  opts: { force: boolean; dryRun: boolean },
): Promise<SaveResult> {
  const memoryFilePath = storePathFor(backend, projectRoot);
  const session = await getBackend(backend).begin({ projectRoot, memoryFilePath });
  try {
    const target = session.store;
    const hasData = target.items.length > 0 || target.proposals.length > 0;
    if (hasData && !opts.force) {
      throw new Error(
        `Target ${backend} store already has ${target.items.length} item(s). Re-run with --force to overwrite.`,
      );
    }

    target.items = source.items;
    target.proposals = source.proposals;
    target.version = source.version;
    target.revision = source.revision;
    target.project.memoryFile = memoryFilePath;

    const result: SaveResult = {
      items: target.items.length,
      proposals: target.proposals.length,
      revision: target.revision,
    };

    if (!opts.dryRun) {
      await session.commit();
    }
    return result;
  } finally {
    await session.release();
  }
}

async function setDefaultBackend(projectRoot: string, backend: BackendKind): Promise<void> {
  const configPath = path.join(projectRoot, ".ai", "memory-mcp.json");
  let config: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
  } catch {
    // missing or corrupt — start fresh
  }
  const storage =
    typeof config.storage === "object" && config.storage !== null
      ? (config.storage as Record<string, unknown>)
      : {};
  storage.backend = backend;
  config.storage = storage;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await fs.rename(tmp, configPath);
}

export async function runMigrate(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  if (!parsed.to) {
    console.error("Missing required --to <json|sqlite>. Example: migrate --to sqlite");
    return 1;
  }

  const target = parsed.to;
  const source: BackendKind = parsed.from ?? (target === "sqlite" ? "json" : "sqlite");
  if (source === target) {
    console.error(`Source and target are both "${target}"; nothing to migrate.`);
    return 1;
  }

  const projectRoot = parsed.projectRoot || (await findProjectRoot());

  console.log(`\nMigrating memory: ${source} -> ${target}`);
  console.log(`Project: ${projectRoot}`);
  console.log(`Source:  ${storePathFor(source, projectRoot)}`);
  console.log(`Target:  ${storePathFor(target, projectRoot)}`);
  if (parsed.dryRun) console.log("Mode:    dry-run (no changes written)\n");
  else console.log("");

  let store: Store;
  try {
    store = await loadFrom(source, projectRoot);
  } catch (err) {
    console.error(`Failed to read ${source} store: ${(err as Error).message}`);
    return 1;
  }

  if (store.items.length === 0 && store.proposals.length === 0) {
    console.log(`Source ${source} store is empty — nothing to migrate.`);
    return 0;
  }

  let result: SaveResult;
  try {
    result = await saveInto(target, projectRoot, store, {
      force: parsed.force,
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    console.error(`Migration aborted: ${(err as Error).message}`);
    return 1;
  }

  if (parsed.dryRun) {
    console.log(
      `Would write ${result.items} item(s), ${result.proposals} proposal(s) to the ${target} store.`,
    );
    return 0;
  }

  // Verify by reloading the target and comparing counts.
  const verify = await loadFrom(target, projectRoot);
  const ok =
    verify.items.length === store.items.length &&
    verify.proposals.length === store.proposals.length;
  if (!ok) {
    console.error(
      `Verification FAILED: expected ${store.items.length}/${store.proposals.length}, got ${verify.items.length}/${verify.proposals.length}.`,
    );
    return 1;
  }

  console.log(
    `Migrated ${result.items} item(s), ${result.proposals} proposal(s). Source left untouched.`,
  );

  if (parsed.setDefault) {
    await setDefaultBackend(projectRoot, target);
    console.log(`Set storage.backend = "${target}" in .ai/memory-mcp.json.`);
  } else {
    console.log(
      `\nTo use the ${target} store, set it as the default:\n  add {"storage":{"backend":"${target}"}} to .ai/memory-mcp.json` +
        `\n  (or re-run with --set-default, or export MEMORY_STORAGE_BACKEND=${target})`,
    );
  }
  return 0;
}
