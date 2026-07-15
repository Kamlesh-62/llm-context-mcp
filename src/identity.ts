/**
 * Per-user author identity (name + team) for memory attribution.
 *
 * Identity is a property of the *person*, not the project, so it lives in one
 * global file (`~/.project-memory-mcp/identity.json`) reused across every
 * project — never in the shared, committable `.ai/` store. Resolution order:
 *
 *   1. env `MEMORY_AUTHOR_NAME` / `MEMORY_AUTHOR_TEAM`   (CI / one-offs)
 *   2. the global identity file                          (set by `setup`)
 *   3. git `user.name`                                   (name only, fallback)
 *
 * If none yield a name, attribution is simply omitted — items stay valid.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Author {
  name: string;
  team?: string;
}

export interface Identity {
  name?: string;
  team?: string;
}

/** Config directory, overridable via `PROJECT_MEMORY_MCP_HOME` (aids testing). */
export function identityDir(): string {
  const override = process.env.PROJECT_MEMORY_MCP_HOME?.trim();
  return override ? override : path.join(homedir(), ".project-memory-mcp");
}

export function identityFilePath(): string {
  return path.join(identityDir(), "identity.json");
}

export function loadIdentity(): Identity {
  try {
    const parsed = JSON.parse(readFileSync(identityFilePath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { name, team } = parsed as Record<string, unknown>;
      return {
        ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
        ...(typeof team === "string" && team.trim() ? { team: team.trim() } : {}),
      };
    }
  } catch {
    // missing or unparseable — treat as no identity set
  }
  return {};
}

/** Merge `patch` into the stored identity and persist it. Returns the result. */
export function saveIdentity(patch: Identity): Identity {
  const next: Identity = { ...loadIdentity() };
  if (patch.name !== undefined) {
    const v = patch.name.trim();
    if (v) next.name = v;
    else delete next.name;
  }
  if (patch.team !== undefined) {
    const v = patch.team.trim();
    if (v) next.team = v;
    else delete next.team;
  }
  const dir = identityDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(identityFilePath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

const gitNameCache = new Map<string, string | undefined>();

function gitUserName(cwd: string): string | undefined {
  if (gitNameCache.has(cwd)) return gitNameCache.get(cwd);
  let name: string | undefined;
  try {
    const out = execFileSync("git", ["config", "user.name"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    name = out || undefined;
  } catch {
    name = undefined;
  }
  gitNameCache.set(cwd, name);
  return name;
}

/**
 * Resolve the author to stamp on a new item, or `undefined` if no name can be
 * determined. `projectRoot` scopes the git fallback (git config can be
 * per-repo); defaults to `process.cwd()`.
 */
export function resolveAuthor(projectRoot?: string): Author | undefined {
  const file = loadIdentity();
  const envName = process.env.MEMORY_AUTHOR_NAME?.trim();
  const envTeam = process.env.MEMORY_AUTHOR_TEAM?.trim();

  const name = envName || file.name || gitUserName(projectRoot ?? process.cwd());
  if (!name) return undefined;

  const team = envTeam || file.team;
  return team ? { name, team } : { name };
}
