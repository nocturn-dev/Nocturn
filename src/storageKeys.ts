/**
 * Единая точка правды для localStorage-ключей, которые читают/пишут
 * НЕЗАВИСИМЫЕ модули: два сырых литерала одного ключа в разных
 * файлах молча расходились бы при переименовании — читатель получал бы
 * дефолт без единой ошибки. Образец паттерна — AUDIO_OUTPUT_KEY в tts.ts
 * («независимые литералы молча расходились бы»).
 *
 * Ключи, принадлежащие одному модулю (пишутся и читаются только им),
 * остаются литералами на месте — в этот реестр их не заводить.
 * Гард-тест storageKeys.test.ts закрепляет: ключи этого реестра не
 * встречаются сырыми литералами вне файла.
 */
export const STORAGE_KEYS = {
  micDevice: "haloui-mic-device",
  theme: "haloui-theme",
  quickentryBind: "haloui-quickentry-bind",
  onboarded: "haloui-onboarded",
  closeToTray: "haloui-close-to-tray",
  checkpointsGit: "haloui-checkpoints-git",
  termShell: "haloui-term-shell",
  keepAwake: "haloui-keep-awake",
  gitAutocommit: "haloui-git-autocommit",
  mcpDeferred: "haloui-mcp-deferred",
  usage: "haloui-usage",
  usageBackfill: "haloui-usage-backfill",
  userProfile: "haloui-user-profile",
  projectRoot: "haloui-project-root",
  lang: "haloui-lang",
  jbWarnDontShow: "haloui-jb-warn-dontshow",
  // appearance: appearance.ts (запись) + main.tsx (boot-чтение код-темы
  // до первого рендера)
  appearance: "haloui-appearance",
  // customCss: userCss.ts (запись) + MainSection (гард confirm импорта
  // CSS: переименование ключа иначе сделало бы confirm молчаливым)
  customCss: "haloui-custom-css",
  // Мультимодульные настройки медиа, плеера, звуков, лимитов и устройств
  media: "haloui-media",
  yt: "haloui-yt",
  notify: "haloui-notify",
  limits: "haloui-limits",
  audioOutput: "haloui-audio-output",
  // Зеркала данных (localStorage-зеркала на случай браузерного превью/фолбэка).
  // Направление синхронизации: Rust/диск -> фронтенд (основной источник истины —
  // файлы на диске; в localStorage зеркало пишется только как локальный кэш/превью,
  // при этом api_key никогда не сохраняется в открытом виде на постоянной основе):
  api: "haloui-api",
  profiles: "haloui-profiles",
  sessions: "haloui-sessions",
  colibri: "haloui-colibri",
} as const;
