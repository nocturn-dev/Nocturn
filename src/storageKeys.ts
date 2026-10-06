/**
 * Единая точка правды для localStorage-ключей, которые читают/пишут
 * НЕЗАВИСИМЫЕ модули (аудит A5-5): два сырых литерала одного ключа в разных
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
} as const;
