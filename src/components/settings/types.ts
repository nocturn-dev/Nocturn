import type { ModelInfo } from "../../api";

export interface ApiStatus {
  kind: "idle" | "checking" | "ok" | "error";
  message?: string;
  models?: ModelInfo[];
}

export type Section =
  | "main"
  | "theme"
  | "profile"
  | "api"
  | "prompts"
  | "skills"
  | "subagents"
  | "commands"
  | "plugins"
  | "mcp"
  | "imagegen"
  | "hooks"
  | "shortcuts"
  | "browser"
  | "computer"
  | "memory"
  | "reflect"
  | "network"
  | "rest"
  | "docs";

/** Навигация настроек: группы как в агентских CLI (Basics / Agent
    capabilities / Data). id: null — раздел-заглушка, будет реализован позже */
