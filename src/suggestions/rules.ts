import {
  RE_VERSION,
  RE_NPM_INSTALL,
  RE_PIP_INSTALL,
  RE_CARGO_ADD,
} from "../../hooks/extractors.js";

import type { RuleCategory, SuggestionRule } from "./types.js";

const RE_DEPLOY = /docker push|npm publish|git tag|deploy|kubectl apply/i;
const RE_CONFIG_FILE = /\.(env|config|ya?ml|toml|ini|json|rc)$/i;

export const ALL_CATEGORIES: RuleCategory[] = [
  "version-check",
  "dependency-change",
  "deploy-release",
  "error-fix",
  "config-change",
];

export const RULES: SuggestionRule[] = [
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
