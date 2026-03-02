import fs from "node:fs/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CONFIG, type SuggestionConfig } from "./config.js";
import { newId, normalizeTags, validateType } from "./domain.js";
import { nowIso } from "./runtime.js";
import type { MemoryType } from "./types.js";
import {
  RE_VERSION,
  RE_NPM_INSTALL,
  RE_PIP_INSTALL,
  RE_CARGO_ADD,
} from "../hooks/extractors.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Rules ────────────────────────────────────────────────────────────────────

type SuggestionRule = {
  category: RuleCategory;
  baseWeight: number;
  memoryType: MemoryType;
  match: (obs: Observation, engine: SuggestionEngine) => string | null;
};

const RE_DEPLOY = /docker push|npm publish|git tag|deploy|kubectl apply/i;
const RE_CONFIG_FILE = /\.(env|config|ya?ml|toml|ini|json|rc)$/i;

const RULES: SuggestionRule[] = [
  {
    category: "version-check",
    baseWeight: 2,
    memoryType: "fact",
    match: (obs) => {
      if (obs.type !== "bash_command" && obs.type !== "bash_output") return null;
      const m = obs.content.match(RE_VERSION);
      return m ? `Version check: ${m[0]}` : null;
    },
  },
  {
    category: "dependency-change",
    baseWeight: 3,
    memoryType: "fact",
    match: (obs) => {
      if (obs.type !== "bash_command") return null;
      const npm = obs.content.match(RE_NPM_INSTALL);
      if (npm) return `Added dependency: ${npm[3] || npm[0]}`;
      const pip = obs.content.match(RE_PIP_INSTALL);
      if (pip) return `Added dependency: ${pip[2] || pip[0]}`;
      const cargo = obs.content.match(RE_CARGO_ADD);
      if (cargo) return `Added dependency: ${cargo[1] || cargo[0]}`;
      return null;
    },
  },
  {
    category: "deploy-release",
    baseWeight: 3,
    memoryType: "note",
    match: (obs) => {
      if (obs.type !== "bash_command") return null;
      const m = obs.content.match(RE_DEPLOY);
      return m ? `Deploy/release: ${obs.content.slice(0, 120)}` : null;
    },
  },
  {
    category: "error-fix",
    baseWeight: 4,
    memoryType: "fact",
    match: (obs, engine) => engine.evaluateErrorFix(obs),
  },
  {
    category: "config-change",
    baseWeight: 2,
    memoryType: "fact",
    match: (obs) => {
      if (obs.type !== "file_edit") return null;
      const m = obs.content.match(RE_CONFIG_FILE);
      return m ? `Config change: ${obs.content.slice(0, 120)}` : null;
    },
  },
];

// ── Feedback defaults ────────────────────────────────────────────────────────

const ALL_CATEGORIES: RuleCategory[] = [
  "version-check",
  "dependency-change",
  "deploy-release",
  "error-fix",
  "config-change",
];

function defaultFeedback(): FeedbackStore {
  const categories = {} as Record<RuleCategory, CategoryFeedback>;
  for (const cat of ALL_CATEGORIES) {
    categories[cat] = { multiplier: 1.0, accepts: 0, rejects: 0 };
  }
  return { categories, updatedAt: nowIso() };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class SuggestionEngine {
  private config: SuggestionConfig;
  private server: McpServer | null = null;
  private projectRoot: string = "";
  private feedbackPath: string = "";
  private window: Observation[] = [];
  private pending: Suggestion[] = [];
  private feedbackCache: FeedbackStore | null = null;

  constructor(config?: Partial<SuggestionConfig>) {
    this.config = { ...CONFIG.suggestions, ...config };
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  setProjectRoot(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.feedbackPath = path.join(projectRoot, this.config.feedbackRelPath);
  }

  // ── Feedback persistence ─────────────────────────────────────────────────

  private async loadFeedback(): Promise<FeedbackStore> {
    if (this.feedbackCache) return this.feedbackCache;
    if (!this.feedbackPath) return defaultFeedback();
    try {
      const raw = await fs.readFile(this.feedbackPath, "utf8");
      const parsed = JSON.parse(raw) as FeedbackStore;
      if (parsed && parsed.categories) {
        this.feedbackCache = parsed;
        return parsed;
      }
    } catch {
      // file missing or corrupt
    }
    const fb = defaultFeedback();
    this.feedbackCache = fb;
    return fb;
  }

  private async saveFeedback(feedback: FeedbackStore): Promise<void> {
    if (!this.feedbackPath) return;
    feedback.updatedAt = nowIso();
    this.feedbackCache = feedback;
    try {
      await fs.mkdir(path.dirname(this.feedbackPath), { recursive: true });
      const tmp = `${this.feedbackPath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(feedback, null, 2), "utf8");
      await fs.rename(tmp, this.feedbackPath);
    } catch {
      // best-effort
    }
  }

  private async updateFeedback(
    category: RuleCategory,
    action: "accept" | "reject",
  ): Promise<void> {
    const feedback = await this.loadFeedback();
    const cat = feedback.categories[category] || {
      multiplier: 1.0,
      accepts: 0,
      rejects: 0,
    };

    if (action === "accept") {
      cat.multiplier = Math.min(
        this.config.feedbackMax,
        cat.multiplier + this.config.feedbackIncrement,
      );
      cat.accepts++;
    } else {
      cat.multiplier = Math.max(
        this.config.feedbackMin,
        cat.multiplier - this.config.feedbackDecrement,
      );
      cat.rejects++;
    }

    feedback.categories[category] = cat;
    await this.saveFeedback(feedback);
  }

  // ── Scoring ──────────────────────────────────────────────────────────────

  private recencyBoost(obsIndex: number, windowLength: number): number {
    const distFromEnd = windowLength - 1 - obsIndex;
    if (distFromEnd < 2) return 1.5;
    if (distFromEnd < 5) return 1.2;
    return 1.0;
  }

  private async buildSuggestion(
    rule: SuggestionRule,
    matchContent: string,
    obs: Observation,
    obsIndex: number,
  ): Promise<Suggestion> {
    const feedback = await this.loadFeedback();
    const catFeedback = feedback.categories[rule.category] || {
      multiplier: 1.0,
      accepts: 0,
      rejects: 0,
    };

    const boost = this.recencyBoost(obsIndex, this.window.length);
    const score = rule.baseWeight * boost * catFeedback.multiplier;
    const confidence = Math.min(score / 10, 1);
    const priority = Math.min(Math.ceil(score), 5);
    const autoSave =
      this.config.autoSaveEnabled && score >= this.config.autoSaveThreshold;

    return {
      id: newId("sug"),
      type: rule.memoryType,
      title: matchContent,
      content: `Detected from ${obs.type}: ${obs.content.slice(0, 200)}`,
      tags: normalizeTags([rule.category, obs.type]),
      confidence,
      priority,
      autoSave,
      source: "suggestion-engine",
      triggeredBy: rule.category,
      score,
      createdAt: nowIso(),
    };
  }

  // ── Error-fix evaluation ─────────────────────────────────────────────────

  evaluateErrorFix(obs: Observation): string | null {
    if (obs.type !== "resolution") return null;

    // Look backwards in window for a preceding error
    for (let i = this.window.length - 1; i >= 0; i--) {
      const prev = this.window[i];
      if (prev.type === "error" || (prev.type === "bash_output" && /error|ERR!|FAIL|fatal:/i.test(prev.content))) {
        return `Resolved: ${prev.content.slice(0, 100)} → ${obs.content.slice(0, 100)}`;
      }
    }
    return null;
  }

  // ── Notification ─────────────────────────────────────────────────────────

  private notify(suggestion: Suggestion): void {
    if (!this.server) return;
    try {
      // Access the underlying Server instance for sendLoggingMessage
      (this.server as any).server?.sendLoggingMessage?.({
        level: "info",
        logger: "suggestion-engine",
        data: { type: "memory_suggestion", ...suggestion },
      });
    } catch {
      // best-effort
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async observe(obs: Observation, projectRoot?: string): Promise<Suggestion[]> {
    if (projectRoot && !this.projectRoot) {
      this.setProjectRoot(projectRoot);
    }

    // Ensure timestamp
    if (!obs.timestamp) {
      obs.timestamp = nowIso();
    }

    // Push to FIFO window
    this.window.push(obs);
    if (this.window.length > this.config.maxWindowSize) {
      this.window.splice(0, this.window.length - this.config.maxWindowSize);
    }

    const obsIndex = this.window.length - 1;
    const results: Suggestion[] = [];

    for (const rule of RULES) {
      const matchContent = rule.match(obs, this);
      if (!matchContent) continue;

      const suggestion = await this.buildSuggestion(
        rule,
        matchContent,
        obs,
        obsIndex,
      );

      if (suggestion.score >= this.config.notifyThreshold) {
        results.push(suggestion);
        this.pending.push(suggestion);
        this.notify(suggestion);
      }
    }

    return results;
  }

  getPendingSuggestions(): Suggestion[] {
    return [...this.pending];
  }

  async acceptSuggestion(id: string): Promise<Suggestion | null> {
    const idx = this.pending.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [suggestion] = this.pending.splice(idx, 1);
    await this.updateFeedback(suggestion.triggeredBy, "accept");
    return suggestion;
  }

  async rejectSuggestion(id: string): Promise<Suggestion | null> {
    const idx = this.pending.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [suggestion] = this.pending.splice(idx, 1);
    await this.updateFeedback(suggestion.triggeredBy, "reject");
    return suggestion;
  }
}
