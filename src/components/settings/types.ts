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

/** Навигация настроек: плоский список из 7 страниц (NAV в SettingsModal).
 *  Тип Section — идентификаторы СТАРЫХ разделов: остался для глубоких
 *  ссылок (App/ChatArea) и поискового индекса, маппится на страницу */

/** Страница настроек: 7 пунктов левой навигации. Технические разделы
 *  склеены по смыслу: agent — поведение агента, tools — инструменты и
 *  связи, system — сеть/статистика/сервисные. Содержимое секций не
 *  менялось: страницы просто стэкают их блоками с разделителями */
export type SettingsPage =
  | "main"
  | "profile"
  | "theme"
  | "api"
  | "agent"
  | "tools"
  | "system";

/** Старый Section → страница, на которой теперь живёт его блок */
export const PAGE_FOR_SECTION: Record<Section, SettingsPage> = {
  main: "main",
  profile: "profile",
  theme: "theme",
  mascot: "theme",
  api: "api",
  prompts: "agent",
  skills: "agent",
  subagents: "agent",
  commands: "agent",
  hooks: "agent",
  memory: "agent",
  permissions: "agent",
  plugins: "tools",
  mcp: "tools",
  lsp: "tools",
  imagegen: "tools",
  browser: "tools",
  computer: "tools",
  network: "system",
  reflect: "system",
  rest: "system",
  integrations: "system",
  docs: "system",
  shortcuts: "system",
};
