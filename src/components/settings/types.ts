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
  | "lsp"
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

/** Навигация настроек: аккордеон из 5 групп и 14 страниц (NAV в
 *  SettingsModal). Тип Section — идентификаторы СТАРЫХ разделов: остался
 *  для глубоких ссылок (App/ChatArea) и поискового индекса, маппится на
 *  страницу */

/** Страница настроек: пункт второго уровня аккордеона. Технические
 *  разделы склеены по смыслу (coreSpecs/agentTools/apiKeys/integrations);
 *  содержимое секций не менялось — страницы стэкают их блоками */
export type SettingsPage =
  | "main"
  | "profile"
  | "theme"
  | "mascot"
  | "shortcuts"
  | "agentCore"
  | "subs"
  | "plugins"
  | "agentTools"
  | "apiKeys"
  | "integrations"
  | "permissions"
  | "network"
  | "reflect"
  | "lsp"
  | "docs";

/** Старый Section → страница, на которой теперь живёт его блок.
 *  MCP живёт на странице Plugins: оба про подключения расширений */
export const PAGE_FOR_SECTION: Record<Section, SettingsPage> = {
  main: "main",
  profile: "profile",
  theme: "theme",
  mascot: "mascot",
  shortcuts: "shortcuts",
  memory: "agentCore",
  prompts: "agentCore",
  skills: "agentCore",
  subagents: "subs",
  plugins: "plugins",
  mcp: "plugins",
  browser: "agentTools",
  computer: "agentTools",
  hooks: "agentTools",
  commands: "agentTools",
  api: "apiKeys",
  imagegen: "apiKeys",
  integrations: "integrations",
  rest: "integrations",
  permissions: "permissions",
  network: "network",
  reflect: "reflect",
  lsp: "lsp",
  docs: "docs",
};
