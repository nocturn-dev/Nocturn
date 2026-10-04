import type { ModelInfo } from "../../api";

export interface ApiStatus {
  kind: "idle" | "checking" | "ok" | "error";
  message?: string;
  models?: ModelInfo[];
}

export type Section =
  | "main"
  | "mascot"
  | "theme"
  | "profile"
  | "api"
  | "prompts"
  | "skills"
  | "subagents"
  | "commands"
  | "plugins"
  | "mcp"
  | "permissions"
  | "imagegen"
  | "hooks"
  | "shortcuts"
  | "browser"
  | "computer"
  | "memory"
  | "reflect"
  | "network"
  | "rest"
  | "integrations"
  | "docs";

/** Навигация настроек: группы как в агентских CLI (Basics / Agent
    capabilities / Data / Rest / Integrations / Help). Сами группы и их
    порядок объявлены в SettingsModal (NAV) — здесь только тип Section */
