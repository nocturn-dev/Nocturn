import type { MsgKey } from "../../locales";
import type { Section } from "./types";

/**
 * Индекс поиска по настройкам: ключи локалей строк внутри каждой секции.
 * Поиск матчится по локализованным подписям в рантайме (t(key)) — работает
 * во всех четырёх языках. Пополняется при добавлении новых настроек.
 * ВАЖНО: ключи обязаны существовать во всех словарях — отсутствующий ключ
 * ломает t() (undefined.toLowerCase()) в поиске. Тип MsgKey переносит эту
 * проверку в компиляцию: протухший ключ в индексе больше не собирается.
 */
export const SETTINGS_SEARCH_INDEX: { section: Section; keys: MsgKey[] }[] = [
  {
    section: "main",
    keys: [
      "main.autostart",
      "main.quickEntry",
      "main.language",
      "main.sidebarSide",
      "main.scrollFollow",
      "main.streamSmooth",
      "main.printSpeed",
      "main.streamCaret",
      "main.showUserMsgs",
      "main.groupTurns",
      "main.showReasoning",
      "main.askAutoContinue",
      "main.autoArchive",
      "main.closeToTray",
      "main.settingsLarge",
      "main.browserPanel",
      "main.notifyDone",
      "main.notifySound",
      "main.exportTitle",
      "limits.title",
      "main.storage",
    ],
  },
  {
    section: "integrations",
    keys: [
      "settings.integrations",
      "integrations.desc",
      "media.blockTitle",
      "media.lyrics",
      "media.ribbon",
      "media.ribbonScale",
      "media.lyricsTheme",
      "media.lyricsCustom",
      "media.cover",
      "media.textShimmer",
      "media.ytOpenPlayer",
      "media.ytAutoCollapse",
      "media.ytLoop",
      "media.ytDrag",
      "media.ytKeepOpen",
      "media.ytSize",
    ],
  },
  {
    section: "profile",
    keys: [
      "profile.who",
      "profile.role",
      "profile.answersLang",
      "profile.tone",
      "profile.stack",
      "profile.focus",
      "profile.instructions",
      "profile.privacy",
    ],
  },
  {
    section: "theme",
    keys: [
      "themes.accent",
      "themes.accentGradient",
      "themes.ambient",
      "themes.ambientScene",
      "themes.fonts",
      "themes.fontUi",
      "themes.fontMono",
      "themes.glass",
      "themes.glassBlur",
      "themes.msgGlass",
      "themes.textShimmer",
      "themes.sidebarGlass",
      "themes.reduceMotion",
      "themes.motionSpeed",
      "themes.scale",
      "themes.markStyle",
      "themes.chatMark",
      "themes.auto",
      "themes.userCss",
      "themes.wallpaper",
    ],
  },
  {
    section: "api",
    keys: [
      "ggufLab.entry",
      "ggufLab.entryDesc",
      "api.baseUrl",
      "api.model",
      "api.fallbackModel",
      "api.key",
      "api.profiles",
      "ollama.title",
    ],
  },
  {
    section: "browser",
    keys: [
      "bu.desc",
      "bu.enabled",
      "bu.executable",
      "bu.headless",
    ],
  },
  {
    section: "computer",
    keys: ["cu.desc", "cu.enabled", "cu.note"],
  },
  {
    section: "lsp",
    keys: [
      "lsp.desc",
      "lsp.enabled",
      "lsp.autoFeedback",
      "lsp.servers",
    ],
  },
  {
    section: "shortcuts",
    keys: [
      "sc.desc",
      "sc.newTask",
      "sc.search",
      "sc.settings",
      "sc.theme",
      "sc.agent",
      "sc.terminal",
      "sc.sidebar",
      "sc.permMode",
      "sc.ytToggle",
      "win.fullscreen",
      "sc.addCustom",
      "sc.comboLabel",
    ],
  },
  {
    section: "memory",
    keys: ["memory.toggle", "memory.factsTitle", "memory.howTitle", "memory.forgetAll"],
  },
  {
    section: "subagents",
    keys: [
      "sub.desc",
      "sub.enabled",
      "sub.roles",
      "sub.maxParallel",
      "sub.maxSteps",
      "sub.model",
      "sub.monitor",
    ],
  },
  {
    section: "plugins",
    keys: ["plug.desc", "plug.import", "plug.commands", "plug.brings", "plug.empty"],
  },
  {
    section: "mcp",
    keys: ["mcp.desc", "mcp.add", "mcp.transport", "mcp.url", "mcp.headers"],
  },
  {
    section: "imagegen",
    keys: ["ig.enabled", "ig.baseUrl", "ig.fallbackHint"],
  },
  {
    // Веб-поиск переехал в раздел «Browser Use» (одна тема: сеть)
    section: "browser",
    keys: ["ws.enabled", "ws.provider", "ws.searxngUrl", "ws.braveKeyDesc"],
  },
  {
    section: "prompts",
    keys: [
      "prompts.desc",
      "prompts.add",
      "prompts.empty",
      "jb.title",
      "jb.desc",
      "jb.builtinTitle",
      "jb.ownTitle",
      "jb.empty",
      "jb.add",
      "jb.searchPh",
      "jb.filterAllModels",
      "jb.filterAllYears",
      "jb.importTitle",
      "jb.liveTitle",
      "jb.liveSearch",
      "jb.liveRefresh",
      "jb.liveHint",
    ],
  },
  {
    section: "skills",
    keys: ["skills.desc", "skills.palette", "skills.fromPlugin"],
  },
  {
    // Allowlist'ы агента живут в разделе «Команды»
    section: "commands",
    keys: ["agent.allowlistDesc", "agent.allowlistAllTitle"],
  },
  {
    section: "commands",
    keys: ["cmds.desc", "cmds.add", "cmds.builtin", "cmds.builtinHint"],
  },
  {
    section: "hooks",
    keys: ["hook.desc", "hook.add", "hook.eventLabel", "hook.commandLabel", "hook.empty"],
  },
  {
    section: "network",
    keys: [
      "network.proxyTitle",
      "network.noProxyTitle",
      "network.caTitle",
      "network.save",
    ],
  },
  {
    section: "reflect",
    keys: ["reflect.period", "reflect.button", "reflect.stalledTitle", "reflect.privacy"],
  },
  {
    section: "rest",
    keys: ["settings.rest", "game.play", "game.record"],
  },
  {
    section: "docs",
    keys: ["docs.intro"],
  },
  {
    section: "permissions",
    keys: [
      "settings.permissions",
      "perm.desc",
      "perm.denyTitle",
      "perm.alwaysAskTitle",
      "perm.allowTitle",
      "perm.allowHint",
    ],
  },
  {
    // Маскот (волна 7132841): секция добавлена в types.ts, но в индекс
    // не попала — поиск настроек её не находил (аудит 2026-10-04)
    section: "mascot",
    keys: [
      "mascot.title",
      "mascot.sectionDesc",
      "mascot.enabled",
      "mascot.enabledDesc",
      "mascot.size",
      "mascot.glow",
      "mascot.self",
      "mascot.selfDesc",
      "mascot.easter",
      "mascot.easterDesc",
      "mascot.colorTheme",
      "mascot.lore",
    ],
  },
];
