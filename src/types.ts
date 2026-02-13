export type MemoryType =
  | "note"
  | "decision"
  | "fact"
  | "constraint"
  | "todo"
  | "architecture"
  | "glossary";

export interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  source?: string;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  proposalId?: string;
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
  version: 1;
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
