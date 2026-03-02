import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CONFIG, type SuggestionConfig } from "../config.js";
import { newId, normalizeTags } from "../domain.js";
import { nowIso } from "../runtime.js";

import type {
  FeedbackStore,
  Observation,
  RuleCategory,
  Suggestion,
  SuggestionRule,
} from "./types.js";
import { RULES } from "./rules.js";
import { defaultFeedback, loadFeedbackFromDisk, saveFeedbackToDisk } from "./feedback.js";

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
    const fb = await loadFeedbackFromDisk(this.feedbackPath);
    this.feedbackCache = fb;
    return fb;
  }

  private async saveFeedback(feedback: FeedbackStore): Promise<void> {
    this.feedbackCache = feedback;
    await saveFeedbackToDisk(this.feedbackPath, feedback);
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

    if (!obs.timestamp) {
      obs.timestamp = nowIso();
    }

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
