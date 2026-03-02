import type { MemoryType } from "../types.js";

export type ObservationType =
  | "bash_command"
  | "bash_output"
  | "file_edit"
  | "tool_call"
  | "text"
  | "error"
  | "resolution";

export interface Observation {
  type: ObservationType;
  content: string;
  toolName?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type RuleCategory =
  | "version-check"
  | "dependency-change"
  | "deploy-release"
  | "error-fix"
  | "config-change";

export interface Suggestion {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  priority: number;
  autoSave: boolean;
  source: string;
  triggeredBy: RuleCategory;
  score: number;
  createdAt: string;
}

export interface CategoryFeedback {
  multiplier: number;
  accepts: number;
  rejects: number;
}

export interface FeedbackStore {
  categories: Record<RuleCategory, CategoryFeedback>;
  updatedAt: string;
}

export type SuggestionRule = {
  category: RuleCategory;
  baseWeight: number;
  memoryType: MemoryType;
  match: (obs: Observation, engine: any) => string | null;
};
