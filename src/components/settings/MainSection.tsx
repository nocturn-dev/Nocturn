import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useLang } from "../../locales";
import type { HardLimits } from "../../limits";
import { NOTIFY_SOUNDS, playSound, refreshCustomSound, NotifyPrefs } from "../../notify";
import { pickSaveFile, pickJsonFile, pickAudioFile, settingsReadAll, settingsWriteAll, settingsExportWrite, settingsImportRead, soundImport, soundDelete, collectLocal, restoreLocal } from "../../api";
import { LangSwitch, Row, ToggleRow } from "./parts";

export function HardLimitSection({
  limits,
  onChange,
}: {
  limits: HardLimits;
  onChange: (l: HardLimits) => void;
}) {
  const { t } = useLang();
  const fields: { key: keyof HardLimits; label: string }[] = [
    { key: "maxTokens", label: t("limits.maxTokens") },
    { key: "usdPer1M", label: t("limits.usdPer1M") },
    { key: "maxUsd", label: t("limits.maxUsd") },
  ];
  const setField = (k: keyof HardLimits, v: string) => {
    const n = Number(v);
    onChange({ ...limits, [k]: v.trim() === "" || !Number.isFinite(n) ? null : n });
  };
  return (
    <div className="mt-5 rounded-xl border border-halo-line px-3.5 py-3">
      <p className="text-sm text-halo-text">{t("limits.title")}</p>
      <p className="mt-0.5 text-xs text-halo-muted">{t("limits.hint")}</p>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        {fields.map((f) => (
          <label key={f.key} className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-xs text-halo-muted" title={f.label}>
              {f.label}
            </span>
            <input
              type="number"
              min={0}
              value={limits[f.key] ?? ""}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder="—"
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function MainSection({
  sidebarSide,
  onSidebarSideChange,
  hideStarter,
  onHideStarterChange,
  scrollFollow,
  onScrollFollowChange,
  streamSmooth,
  showReasoning,
  askAutoContinue,
  autoArchive,
  archiveRetention,
  onStreamSmoothChange,
  onShowReasoningChange,
  onAskAutoContinueChange,
  onAutoArchiveChange,
  onArchiveRetentionChange,
  onArchiveNow,
  closeToTray,
  onCloseToTrayChange,
  streamCaret,
  onStreamCaretChange,
  showUserMsgs,
  onShowUserMsgsChange,
  groupTurns,
  onGroupTurnsChange,
  notifyPrefs,
  onNotifyPrefsChange,
  settingsLarge,
  onSettingsLargeChange,
  browserPanel,
  onBrowserPanelChange,
  limits,
  onLimitsChange,
}: {
  sidebarSide: "left" | "right";
  onSidebarSideChange: (side: "left" | "right") => void;
  hideStarter: boolean;
  onHideStarterChange: (v: boolean) => void;
  /** Поведение генерации */
  scrollFollow: boolean;
  onScrollFollowChange: (v: boolean) => void;
  streamSmooth: boolean;
  onStreamSmoothChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  askAutoContinue: boolean;
  onAskAutoContinueChange: (v: boolean) => void;
  autoArchive: boolean;
  onAutoArchiveChange: (v: boolean) => void;
  archiveRetention: number;
  onArchiveRetentionChange: (d: number) => void;
  onArchiveNow: () => void;
  closeToTray: boolean;
  onCloseToTrayChange: (v: boolean) => void;
  streamCaret: boolean;
  onStreamCaretChange: (v: boolean) => void;
  showUserMsgs: boolean;
  onShowUserMsgsChange: (v: boolean) => void;
  /** Весь ход агента — одной карточкой */
  groupTurns: boolean;
  onGroupTurnsChange: (v: boolean) => void;
  /** Уведомления о завершении/подтверждении, когда окно не в фокусе */
  notifyPrefs: NotifyPrefs;
  onNotifyPrefsChange: (p: NotifyPrefs) => void;
  settingsLarge: boolean;
  onSettingsLargeChange: (v: boolean) => void;
  /** Автооткрытие панели живого просмотра браузера агента */
  browserPanel: boolean;
  onBrowserPanelChange: (v: boolean) => void;
  /** Hard Limit: лимиты расхода на задачу (токены/$) */
  limits: HardLimits;
  onLimitsChange: (l: HardLimits) => void;
}) {
  const { t } = useLang();
  // Версия — из самого приложения (tauri.conf.json), а не из локали: раньше
  // «0.2.0-alpha» было захардкожено в четырёх словарях и врало после релиза.
  // В браузерном превью getVersion() недоступен — показываем фолбэк из локали
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Экспорт API-ключей — по умолчанию выключен: файлом настроек можно
  // делиться, не отдавая ключи провайдеров (маскирование на бэкенде)
  const [exportSecrets, setExportSecrets] = useState(false);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  const versionValue = appVersion
    ? `${t("main.versionStage")} v${appVersion}`
    : t("main.versionVal");
  return (
    <div className="space-y-1">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.main")}</h3>
      <Row label={t("main.version")} value={versionValue} />
      <Row
        label={t("main.language")}
        desc={t("main.languageDesc")}
        value=""
        extra={<LangSwitch />}
      />
      <ToggleRow
        label={t("main.sidebarSide")}
        desc={t("main.sidebarSideDesc")}
        on={sidebarSide === "right"}
        onChange={(v) => onSidebarSideChange(v ? "right" : "left")}
      />
      <ToggleRow
        label={t("main.hideStarter")}
        desc={t("main.hideStarterDesc")}
        on={hideStarter}
        onChange={onHideStarterChange}
      />
      <ToggleRow
        label={t("main.scrollFollow")}
        desc={t("main.scrollFollowDesc")}
        on={scrollFollow}
        onChange={onScrollFollowChange}
      />
      <ToggleRow
        label={t("main.streamSmooth")}
        desc={t("main.streamSmoothDesc")}
        on={streamSmooth}
        onChange={onStreamSmoothChange}
      />
      <ToggleRow
        label={t("main.streamCaret")}
        desc={t("main.streamCaretDesc")}
        on={streamCaret}
        onChange={onStreamCaretChange}
      />
      <ToggleRow
        label={t("main.showUserMsgs")}
        desc={t("main.showUserMsgsDesc")}
        on={showUserMsgs}
        onChange={onShowUserMsgsChange}
      />
      <ToggleRow
        label={t("main.groupTurns")}
        desc={t("main.groupTurnsDesc")}
        on={groupTurns}
        onChange={onGroupTurnsChange}
      />
      <ToggleRow
        label={t("main.showReasoning")}
        desc={t("main.showReasoningDesc")}
        on={showReasoning}
        onChange={onShowReasoningChange}
      />
      <ToggleRow
        label={t("main.askAutoContinue")}
        desc={t("main.askAutoContinueDesc")}
        on={askAutoContinue}
        onChange={onAskAutoContinueChange}
      />
      <ToggleRow
        label={t("main.autoArchive")}
        desc={t("main.autoArchiveDesc")}
        on={autoArchive}
        onChange={onAutoArchiveChange}
      />
      <ToggleRow
        label={t("main.closeToTray")}
        desc={t("main.closeToTrayDesc")}
        on={closeToTray}
        onChange={onCloseToTrayChange}
      />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
        <span className="text-xs text-halo-muted">{t("main.archiveAfter")}:</span>
        {[3, 7, 30].map((d) => (
          <button
            key={d}
            onClick={() => onArchiveRetentionChange(d)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              archiveRetention === d
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {d}
          </button>
        ))}
        <button
          onClick={onArchiveNow}
          className="ml-auto rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("main.archiveNow")}
        </button>
      </div>
      <ToggleRow
        label={t("main.settingsLarge")}
        desc={t("main.settingsLargeDesc")}
        on={settingsLarge}
        onChange={onSettingsLargeChange}
      />
      <ToggleRow
        label={t("main.browserPanel")}
        desc={t("main.browserPanelDesc")}
        on={browserPanel}
        onChange={onBrowserPanelChange}
      />

      {/* Уведомления, когда пользователь не в приложении */}
      <ToggleRow
        label={t("main.notifyDone")}
        desc={t("main.notifyDoneDesc")}
        on={notifyPrefs.enabled}
        onChange={(v) => onNotifyPrefsChange({ ...notifyPrefs, enabled: v })}
      />
      {notifyPrefs.enabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
          <span className="text-xs text-halo-muted">{t("main.notifySound")}:</span>
          {NOTIFY_SOUNDS.map((snd) => (
            <button
              key={snd.id}
              onClick={() => {
                onNotifyPrefsChange({ ...notifyPrefs, sound: snd.id });
                playSound(snd.id); // прослушка при выборе
              }}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                notifyPrefs.sound === snd.id
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(snd.labelKey as never)}
            </button>
          ))}
          {/* Своя мелодия: импорт файла, прослушка, удаление */}
          <button
            onClick={async () => {
              try {
                const src = await pickAudioFile();
                if (!src) return;
                const res = await soundImport(src); // "имя|расширение"
                const [name] = res.split("|");
                onNotifyPrefsChange({ ...notifyPrefs, sound: "custom", customName: name });
                void refreshCustomSound().then(() => playSound("custom"));
              } catch {
                // отмена/ошибка выбора — просто ничего не меняем
              }
            }}
            title={t("main.notifyCustomImport")}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              notifyPrefs.sound === "custom"
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            + {notifyPrefs.customName || t("main.notifyCustomImport")}
          </button>
          {notifyPrefs.customName && (
            <button
              onClick={async () => {
                await soundDelete();
                onNotifyPrefsChange({
                  ...notifyPrefs,
                  sound: "chime",
                  customName: undefined,
                });
              }}
              title={t("main.notifyCustomClear")}
              className="rounded-md px-1.5 py-1 text-xs text-halo-muted transition-colors hover:text-red-400"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Hard Limit: прерывание задачи при превышении лимитов расхода */}
      <HardLimitSection limits={limits} onChange={onLimitsChange} />

      {/* Экспорт/импорт всех настроек одним файлом */}
      <div className="rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("main.exportTitle")}</p>
        <p className="mt-0.5 text-xs text-halo-muted">{t("main.exportHint")}</p>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-halo-muted">
          <input
            type="checkbox"
            checked={exportSecrets}
            onChange={(e) => setExportSecrets(e.target.checked)}
            className="accent-halo-accent"
          />
          <span>{t("main.exportSecrets")}</span>
        </label>
        <div className="mt-2 flex gap-2">
          <button
            onClick={async () => {
              try {
                if (
                  exportSecrets &&
                  !window.confirm(t("main.exportSecretsWarn"))
                ) {
                  return;
                }
                const path = await pickSaveFile("nocturn-settings.json");
                if (!path) return;
                const files = await settingsReadAll(exportSecrets);
                await settingsExportWrite(
                  path,
                  JSON.stringify({ version: 1, files, local: collectLocal() }, null, 2),
                );
              } catch (e) {
                window.alert(String(e));
              }
            }}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("main.exportBtn")}
          </button>
          <button
            onClick={async () => {
              try {
                const path = await pickJsonFile();
                if (!path) return;
                if (!window.confirm(t("main.importConfirm"))) return;
                const data = await settingsImportRead(path);
                let n = 0;
                if (data.files && Object.keys(data.files).length > 0) {
                  // hooks.json/mcp.json исполняют произвольные команды:
                  // импорт «поделенного конфига» без явного подтверждения = RCE
                  const execList = describeExecutableConfigs(data.files);
                  if (execList) {
                    if (
                      !window.confirm(
                        t("main.importExecutableWarn", { list: execList }),
                      )
                    )
                      return;
                    n = await settingsWriteAll(data.files, true);
                  } else {
                    n = await settingsWriteAll(data.files);
                  }
                }
                if (data.local) restoreLocal(data.local);
                window.alert(t("main.importDone", { n }));
                location.reload();
              } catch (e) {
                window.alert(String(e));
              }
            }}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("main.importBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Список исполняемых конфигов во входном файле импорта: команды хуков
 * и команды запуска MCP-серверов. null — исполняемых конфигов нет.
 * Используется для явного подтверждения перед импортом (защита от RCE
 * через импорт «поделенного конфига»).
 */
export function describeExecutableConfigs(
  files: Record<string, unknown>,
): string | null {
  const lines: string[] = [];
  const hooks = (
    files["hooks.json"] as
      | { hooks?: Array<{ command?: unknown; event?: unknown }> }
      | undefined
  )?.hooks;
  if (Array.isArray(hooks)) {
    for (const h of hooks) {
      if (h && typeof h.command === "string" && h.command.trim() !== "") {
        lines.push(
          `• hook [${typeof h.event === "string" ? h.event : "*"}]: ${h.command}`,
        );
      }
    }
  }
  const servers = files["mcp.json"];
  if (Array.isArray(servers)) {
    for (const s of servers) {
      if (s && typeof s.command === "string" && s.command.trim() !== "") {
        const args = Array.isArray(s.args) ? s.args.join(" ") : "";
        lines.push(
          `• mcp [${typeof s.name === "string" ? s.name : "?"}]: ${s.command}${args ? ` ${args}` : ""}`,
        );
      }
    }
  }
  if (lines.length === 0) return null;
  return lines.slice(0, 20).join("\n");
}

/** Раздел «MCP»: управление серверами внешних инструментов (M2-MCP) */
