export type RunnerKey = "npx" | "global" | "node" | "custom";

export type Runner = {
  command: string;
  args: string[];
  label: string;
  key: RunnerKey;
};

export type SavedRunner = {
  key: RunnerKey;
  command: string;
  args: string[];
};

export type ProjectDefaults = {
  serverId?: string;
  runner?: SavedRunner;
};

export type CliSelection = {
  claude: boolean;
  gemini: boolean;
  codex: boolean;
};

export type CommonArgs = {
  projectRoot: string | null;
  cliFilters: string[] | null;
  acceptDefaults: boolean;
  help: boolean;
};

export type ParsedArgs = CommonArgs & {
  serverId: string | null;
  runner: string | null;
  customCommand: string | null;
  customArgs: string | null;
};

export type StepResult = {
  label: string;
  ok: boolean;
  error?: Error;
};
