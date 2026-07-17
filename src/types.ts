export type MemoryType =
  | "note"
  | "decision"
  | "fact"
  | "constraint"
  | "todo"
  | "architecture"
  | "glossary";

export interface MemoryItemAuthor {
  name: string;
  team?: string;
}

/** Typed relationship between two memory items. */
export type LinkRel =
  | "part-of"
  | "relates-to"
  | "depends-on"
  | "supersedes"
  | "example-of";

/** A directed edge from the owning item to `to`. */
export interface MemoryLink {
  to: string;
  rel: LinkRel;
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  /**
   * Optional grouping bucket (e.g. "orders", "commissions", "auth"). One per
   * item — the memory's home domain. Used to scope/boost retrieval. Slugified
   * via normalizeDomain. Backward-compatible: absent on pre-Phase-1 items.
   */
  domain?: string;
  /** Typed edges to other items (part-of, depends-on, supersedes, …). */
  links?: MemoryLink[];
  source?: string;
  author?: MemoryItemAuthor;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  proposalId?: string;
  expiresAt?: string;
  archivedAt?: string;
  archivedReason?: string;
}

export interface MemoryProposal {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  pinned?: boolean;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

export interface StoreProject {
  id: string;
  root: string;
  memoryFile: string;
  createdAt: string;
  updatedAt: string;
}

export interface Store {
  version: number;
  project: StoreProject;
  items: MemoryItem[];
  proposals: MemoryProposal[];
  revision: number;
}

export interface StoreContext {
  projectRoot: string;
  memoryFilePath: string;
}

export interface StoreWriteResult {
  store: Store;
  projectRoot: string;
  memoryFilePath: string;
}

export interface ArchiveStore {
  version: 1;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  items: MemoryItem[];
  revision: number;
}
