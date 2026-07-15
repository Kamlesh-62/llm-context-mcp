import type { Store } from "../types.js";

/**
 * Current on-disk store-format version. Bump this whenever the shape of the
 * persisted store changes, and register a transform in MIGRATIONS below that
 * upgrades the previous version to the new one.
 */
export const STORE_VERSION = 1;

/**
 * Raised when a store file is present but its contents cannot be safely used
 * (corrupt JSON, wrong shape, or a version newer than this tool understands).
 *
 * This is deliberately distinct from "file missing": a missing file is a fresh
 * start, but a present-but-unreadable file must NEVER be silently discarded and
 * overwritten — that destroys real data. Callers surface this instead of
 * resetting the store.
 */
export class StoreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreFormatError";
  }
}

/**
 * Sequential store-format transforms keyed by the version they upgrade FROM.
 * Each entry takes a raw store at version `N` and returns a raw store at
 * version `N + 1`. Empty today (v1 is the first format); add entries here as
 * the format evolves so old files are upgraded in place rather than rejected.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and, if needed, upgrade a parsed store object to the current format.
 *
 * Throws {@link StoreFormatError} for anything that is present but unusable:
 *  - not an object
 *  - missing/invalid `version`
 *  - a version newer than {@link STORE_VERSION} (file written by a newer tool)
 *  - a version with no registered migration path
 *  - a final shape without `items`/`proposals` arrays
 *
 * On success returns a `Store` at {@link STORE_VERSION}. Never returns an empty
 * store — that decision belongs to the caller, and only when the file is absent.
 */
export function migrateRawStore(raw: unknown): Store {
  if (!isPlainObject(raw)) {
    throw new StoreFormatError("Store file is not a JSON object");
  }

  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new StoreFormatError(`Store file has invalid version: ${String(version)}`);
  }

  if (version > STORE_VERSION) {
    throw new StoreFormatError(
      `Store file version ${version} is newer than supported version ${STORE_VERSION}. Upgrade context-bridge-mcp.`,
    );
  }

  let current: Record<string, unknown> = raw;
  let currentVersion = version;
  while (currentVersion < STORE_VERSION) {
    const migrate = MIGRATIONS[currentVersion];
    if (!migrate) {
      throw new StoreFormatError(
        `No migration registered from store version ${currentVersion} to ${currentVersion + 1}`,
      );
    }
    current = migrate(current);
    currentVersion += 1;
    current.version = currentVersion;
  }

  if (!Array.isArray(current.items) || !Array.isArray(current.proposals)) {
    throw new StoreFormatError("Store file is missing items/proposals arrays");
  }

  return current as unknown as Store;
}
