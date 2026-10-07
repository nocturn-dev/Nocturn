import { STORAGE_KEYS } from "../../storageKeys";
import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useLang, type Lang } from "../../locales";
import type { HardLimits } from "../../limits";
import { NOTIFY_SOUNDS, playSound, refreshCustomSound, NotifyPrefs, type RunSoundPrefs } from "../../notify";
import { pickSaveFile, pickJsonFile, pickAudioFile, pickCliFile, settingsReadAll, settingsWriteAll, settingsExportWrite, settingsImportRead, soundImport, soundDelete, collectLocal, restoreLocal, autostartIsEnabled, autostartSet, storageStats, storageCleanup, quickentrySetBind, dictationStatus, dictationDownloadModel, dictationSetConfig, voiceStatus, voiceDownloadModels, audioOutputs, type DictationStatus, type VoiceStatus, type StorageStats } from "../../api";
import type { VoiceSettings } from "../../voice/prefs";
import { VOICE_MODEL_LABELS } from "../../voice/prefs";
import { AUDIO_OUTPUT_KEY } from "../../tts";
import type { WakeModel } from "../../voice/wake";
import { parseChatGptExport, parseGeminiExport } from "../../external/importChats";
import type { Session } from "../../types";
import { quickentryComboFromEvent, prettyQuickentryCombo } from "../../shortcuts";
import { Dropdown, LangSwitch, Row, ToggleRow } from "./parts";
import { isWindows } from "../../platform";
import { XSmallIcon } from "../cards/icons";

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

/** Формат размера для «Хранилища»: <1 КБ → байты, <1 МБ → КБ, иначе МБ */
function fmtBytes(n: number, lang: Lang): string {
  const u = lang === "ru" ? ["Б", "КБ", "МБ"] : ["B", "KB", "MB"];
  if (n < 1024) return `${n} ${u[0]}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ${u[1]}`;
  return `${(n / (1024 * 1024)).toFixed(1)} ${u[2]}`;
}

/** Строка «Хранилища»: имя каталога, размер; для чистящихся — двухшаговая кнопка */
function StorageRow({
  label,
  bytes,
  lang,
  cleanLabel,
  confirmLabel,
  confirm,
  onClean,
}: {
  label: string;
  bytes: number;
  lang: Lang;
  /** Кнопка очистки: подписи обычного и подтверждающего шага */
  cleanLabel?: string;
  confirmLabel?: string;
  confirm?: boolean;
  onClean?: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm">
      <span className="min-w-0 truncate text-halo-text">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-halo-muted">{fmtBytes(bytes, lang)}</span>
        {onClean && cleanLabel && (
          <button
            onClick={onClean}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              confirm
                ? "border-red-400/50 text-red-400"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {confirm ? confirmLabel : cleanLabel}
          </button>
        )}
      </span>
    </div>
  );
}

/** Подгруппа настроек: заголовок + описание (структура «Основного») */
function Group({
  title,
  desc,
  gap = "space-y-1",
  children,
}: {
  title: string;
  desc: string;
  /** Шаг между блоками: рядам хватает 4px, крупным карточкам — 12px */
  gap?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5">
      <p className="px-2.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">
        {title}
      </p>
      <p className="mb-1 mt-0.5 px-2.5 text-xs leading-relaxed text-halo-muted">{desc}</p>
      <div className={gap}>{children}</div>
    </div>
  );
}

export function MainSection({
  sidebarSide,
  onSidebarSideChange,
  scrollFollow,
  onScrollFollowChange,
  streamSmooth,
  highlightLive,
  printSpeed,
  hardMode,
  onHardModeChange,
  gitAutocommit,
  onGitAutocommitChange,
  showReasoning,
  transcriptView,
  askAutoContinue,
  autoArchive,
  archiveRetention,
  voice,
  onVoiceChange,
  onStreamSmoothChange,
  onHighlightLiveChange,
  onPrintSpeedChange,
  onShowReasoningChange,
  onTranscriptViewChange,
  onAskAutoContinueChange,
  onAutoArchiveChange,
  onArchiveRetentionChange,
  onArchiveNow,
  onExportChats,
  closeToTray,
  onCloseToTrayChange,
  autoUpdateCheck,
  onAutoUpdateCheckChange,
  streamCaret,
  onStreamCaretChange,
  showUserMsgs,
  onShowUserMsgsChange,
  groupTurns,
  onGroupTurnsChange,
  notifyPrefs,
  onNotifyPrefsChange,
  runSoundPrefs,
  onRunSoundPrefsChange,
  settingsLarge,
  onSettingsLargeChange,
  browserPanel,
  onBrowserPanelChange,
  limits,
  onLimitsChange,
  onImportSessions,
}: {
  sidebarSide: "left" | "right";
  onSidebarSideChange: (side: "left" | "right") => void;
  /** Поведение генерации */
  scrollFollow: boolean;
  onScrollFollowChange: (v: boolean) => void;
  streamSmooth: boolean;
  onStreamSmoothChange: (v: boolean) => void;
  /** Подсветка кода во время стрима (тумблер рядом с «Плавной печатью») */
  highlightLive: boolean;
  onHighlightLiveChange: (v: boolean) => void;
  /** Множитель скорости плавной печати (0.5 / 1 / 2) */
  printSpeed: number;
  onPrintSpeedChange: (v: number) => void;
  /** Hard-Mode: терминальный скин */
  hardMode: boolean;
  onHardModeChange: (v: boolean) => void;
  /** Git-автокоммит перед правками агента (opt-in) */
  gitAutocommit: boolean;
  onGitAutocommitChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  /** Вид ленты по умолчанию: normal | thinking | verbose */
  transcriptView: "normal" | "thinking" | "verbose";
  onTranscriptViewChange: (v: "normal" | "thinking" | "verbose") => void;
  askAutoContinue: boolean;
  onAskAutoContinueChange: (v: boolean) => void;
  autoArchive: boolean;
  onAutoArchiveChange: (v: boolean) => void;
  archiveRetention: number;
  onArchiveRetentionChange: (d: number) => void;
  onArchiveNow: () => void;
  /** Экспорт всех чатов одним JSON-архивом */
  onExportChats: () => void;
  closeToTray: boolean;
  onCloseToTrayChange: (v: boolean) => void;
  /** Проверка обновлений при старте — opt-in, гейтит единственный
   *  несанкционированный ранее сетевой запрос (github latest.json) */
  autoUpdateCheck: boolean;
  onAutoUpdateCheckChange: (v: boolean) => void;
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
  /** Звуки прогона: фоновая обратная связь в фокусе приложения */
  runSoundPrefs: RunSoundPrefs;
  onRunSoundPrefsChange: (p: RunSoundPrefs) => void;
  settingsLarge: boolean;
  onSettingsLargeChange: (v: boolean) => void;
  /** Автооткрытие панели живого просмотра браузера агента */
  browserPanel: boolean;
  onBrowserPanelChange: (v: boolean) => void;
  /** Hard Limit: лимиты расхода на задачу (токены/$) */
  limits: HardLimits;
  onLimitsChange: (l: HardLimits) => void;
  /** Импорт истории из внешних экспортов: готовые сессии App дописывает в список */
  onImportSessions: (sessions: Session[]) => void;
  /** Voice Wake («Jarvis-режим»): тумблер и параметры слушателя */
  voice: VoiceSettings;
  onVoiceChange: (patch: Partial<VoiceSettings>) => void;
}) {
  const { t, lang } = useLang();
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

  // Автозапуск с ОС: состояние — истина из плагина (реестр/LaunchAgent),
  // не из локали; ошибка переключения откатывает тумблер
  const [autostartOn, setAutostartOn] = useState(false);
  useEffect(() => {
    autostartIsEnabled()
      .then(setAutostartOn)
      .catch(() => {});
  }, []);
  const toggleAutostart = async () => {
    const next = !autostartOn;
    setAutostartOn(next);
    try {
      await autostartSet(next);
    } catch {
      setAutostartOn(!next);
    }
  };

  // Хранилище: размеры каталогов appdata; null вне Tauri — блок не рисуем
  const [stats, setStats] = useState<StorageStats | null>(null);
  // Строка, у которой кнопка очистки уже в шаге «Точно?»
  const [confirmKind, setConfirmKind] = useState<"checkpoints" | "images" | null>(null);
  useEffect(() => {
    storageStats()
      .then(setStats)
      .catch(() => {});
  }, []);
  const cleanStorage = async (kind: "checkpoints" | "images") => {
    // Первый клик — только подтверждение намерения, второй — сама очистка
    if (confirmKind !== kind) {
      setConfirmKind(kind);
      return;
    }
    setConfirmKind(null);
    try {
      await storageCleanup(kind);
      const s = await storageStats();
      if (s) setStats(s);
    } catch (e) {
      window.alert(String(e));
    }
  };

  // Сегмент «Вид ленты» двигает только авто-раскрытие размышлений.
  // «Показывать мои сообщения» — отдельный выбор пользователя: сегмент его
  // не трогает (иначе тумблер «скакал» при переключении видов)
  const changeTranscriptView = (v: "normal" | "thinking" | "verbose") => {
    onTranscriptViewChange(v);
    onShowReasoningChange(v !== "normal");
  };

  // Quick Entry: глобальное комбо. Храним в localStorage — бекенд применяет
  // его при старте (App читает prefs до монтирования настроек).
  // Дефолт дублируется бекендом (lib.rs setup/restore) — держать синхронно;
  // ctrl+shift, не ctrl+alt: AltGr+Space на AZERTY — типографский пробел
  // (аудит A3-6)
  const [qeBind, setQeBind] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.quickentryBind) ?? "ctrl+shift+space",
  );
  const [qeRecording, setQeRecording] = useState(false);
  // Диктовка (Whisper): статус CLI/модели; во время скачивания — опрос
  const [dictStatus, setDictStatus] = useState<DictationStatus | null>(null);
  const [dictBusy, setDictBusy] = useState(false);
  const refreshDictStatus = useCallback(() => {
    void dictationStatus()
      .then(setDictStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshDictStatus();
  }, [refreshDictStatus]);
  useEffect(() => {
    if (!dictStatus?.downloading) return;
    const iv = window.setInterval(refreshDictStatus, 1500);
    return () => window.clearInterval(iv);
  }, [dictStatus?.downloading, refreshDictStatus]);
  const downloadDictModel = () => {
    setDictBusy(true);
    void dictationDownloadModel()
      .then(refreshDictStatus)
      .catch((e) => window.alert(String(e)))
      .finally(() => setDictBusy(false));
  };
  const pickDictCli = () => {
    void pickCliFile().then((p) => {
      if (p === null) return;
      void dictationSetConfig(p)
        .catch((e) => window.alert(String(e)))
        .then(refreshDictStatus);
    });
  };
  const dictDesc = !dictStatus
    ? ""
    : !dictStatus.cliFound
      ? t("dictation.needCli")
      : !dictStatus.modelExists
        ? t("dictation.needModel")
        : t("dictation.ready");
  // Микрофон диктовки: выбор устройства ввода (ключ дублирует ChatArea —
  // там deviceId в getUserMedia). Метки устройств пусты, пока браузер не
  // выдал разрешение на микрофон — до того показываем безымянные опции
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(
    () => localStorage.getItem(STORAGE_KEYS.micDevice) ?? "",
  );
  const refreshMics = useCallback(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setMics(all.filter((d) => d.kind === "audioinput")))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshMics();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
  }, [refreshMics]);
  const pickMic = (id: string) => {
    setMicId(id);
    localStorage.setItem(STORAGE_KEYS.micDevice, id);
    if (!id) return;
    // Короткий запрос выбранного устройства: выдаёт разрешение, после чего
    // в списке появляются настоящие названия вместо «Микрофон N»
    void navigator.mediaDevices
      ?.getUserMedia({ audio: { deviceId: { exact: id } } })
      .then((s) => {
        s.getTracks().forEach((tr) => tr.stop());
        refreshMics();
      })
      .catch(() => {});
  };
  // Voice Wake: статус моделей (скачивание опрашивается, как у диктовки)
  const [voiceStatusState, setVoiceStatusState] = useState<VoiceStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const refreshVoiceStatus = useCallback(() => {
    void voiceStatus(voice.model)
      .then(setVoiceStatusState)
      .catch(() => {});
    // voice.model — зависимость: смена фразы проверяет её файл
  }, [voice.model]);
  useEffect(() => {
    refreshVoiceStatus();
  }, [refreshVoiceStatus]);
  useEffect(() => {
    if (!voiceStatusState?.downloading) return;
    const iv = window.setInterval(refreshVoiceStatus, 1000);
    return () => window.clearInterval(iv);
  }, [voiceStatusState?.downloading, refreshVoiceStatus]);
  const downloadVoiceModels = () => {
    setVoiceBusy(true);
    void voiceDownloadModels(voice.model)
      .then(refreshVoiceStatus)
      .catch((e) => window.alert(String(e)))
      .finally(() => setVoiceBusy(false));
  };
  const voiceModelsReady = (voiceStatusState?.files ?? []).every((f) => f.exists);
  // Устройство вывода речи (TTS): список с бекенда, выбор — в localStorage
  // (tts.ts читает его напрямую при каждом speak, паттерн haloui-mic-device)
  const [audioOut, setAudioOut] = useState(
    () => localStorage.getItem(AUDIO_OUTPUT_KEY) ?? "",
  );
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  useEffect(() => {
    if (!voice.wake) return;
    void audioOutputs()
      .then(setAudioDevices)
      .catch(() => {});
  }, [voice.wake]);
  useEffect(() => {
    if (!qeRecording) return;
    const onKey = (e: KeyboardEvent) => {
      // Перехват на capture-фазе: запись не должна дёргать хоткеи и модалку
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setQeRecording(false);
        return;
      }
      const combo = quickentryComboFromEvent(e);
      if (!combo) return; // соло-модификатор/неподдерживаемая клавиша — ждём
      setQeRecording(false);
      setQeBind(combo);
      localStorage.setItem(STORAGE_KEYS.quickentryBind, combo);
      void quickentrySetBind(combo).catch(() => {
        // Комбо могло быть занято другим приложением — откат на прежнее
        void quickentrySetBind(qeBind).catch(() => {});
        setQeBind(qeBind);
        localStorage.setItem(STORAGE_KEYS.quickentryBind, qeBind);
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [qeRecording, qeBind]);

  return (
    <div className="space-y-1">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("settings.main")}</h3>
      <Group title={t("main.g1")} desc={t("main.g1Desc")}>
      {/* Тумблер обновлений — САМЫЙ первый контрол секции: кто хочет получать
          версии, найдёт его сразу и не останется на старой; кому не нужно —
          просто не включает (дефолт off, опционально) */}
      <ToggleRow
        label={t("main.autoUpdate")}
        desc={t("main.autoUpdateDesc")}
        on={autoUpdateCheck}
        onChange={onAutoUpdateCheckChange}
      />
      <Row label={t("main.version")} value={versionValue} />
      <ToggleRow
        label={t("main.autostart")}
        desc={t("main.autostartDesc")}
        on={autostartOn}
        onChange={() => void toggleAutostart()}
      />
      <Row
        label={t("main.language")}
        desc={t("main.languageDesc")}
        value=""
        extra={<LangSwitch />}
      />
      <ToggleRow
        label={t("main.closeToTray")}
        desc={t("main.closeToTrayDesc")}
        on={closeToTray}
        onChange={onCloseToTrayChange}
      />
      <ToggleRow
        label={t("main.settingsLarge")}
        desc={t("main.settingsLargeDesc")}
        on={settingsLarge}
        onChange={onSettingsLargeChange}
      />
      <ToggleRow
        label={t("main.sidebarSide")}
        desc={t("main.sidebarSideDesc")}
        on={sidebarSide === "right"}
        onChange={(v) => onSidebarSideChange(v ? "right" : "left")}
      />
      </Group>
      <Group title={t("main.g2")} desc={t("main.g2Desc")}>
      {/* Вид ленты по умолчанию: normal — только ответы, thinking —
          раскрывать размышления, verbose — плюс сообщения пользователя */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
        <span className="text-xs text-halo-muted">{t("main.view")}:</span>
        {(
          [
            ["normal", "main.viewNormal"],
            ["thinking", "main.viewThinking"],
            ["verbose", "main.viewVerbose"],
          ] as const
        ).map(([v, key]) => (
          <button
            key={v}
            onClick={() => changeTranscriptView(v)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              transcriptView === v
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {t(key)}
          </button>
        ))}
      </div>
      <ToggleRow
        label={t("main.showReasoning")}
        desc={t("main.showReasoningDesc")}
        on={showReasoning}
        onChange={onShowReasoningChange}
      />
      <ToggleRow
        label={t("main.showUserMsgs")}
        desc={t("main.showUserMsgsDesc")}
        on={showUserMsgs}
        onChange={onShowUserMsgsChange}
      />
      <ToggleRow
        label={t("main.scrollFollow")}
        desc={t("main.scrollFollowDesc")}
        on={scrollFollow}
        onChange={onScrollFollowChange}
      />
      <ToggleRow
        label={t("main.groupTurns")}
        desc={t("main.groupTurnsDesc")}
        on={groupTurns}
        onChange={onGroupTurnsChange}
      />
      <ToggleRow
        label={t("main.streamSmooth")}
        desc={t("main.streamSmoothDesc")}
        on={streamSmooth}
        onChange={onStreamSmoothChange}
      />
      <ToggleRow
        label={t("main.highlightLive")}
        desc={t("main.highlightLiveDesc")}
        on={highlightLive}
        onChange={onHighlightLiveChange}
      />
      {/* Скорость плавной печати: множитель догоняющего темпа карточки */}
      {streamSmooth && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
          <span className="text-xs text-halo-muted">{t("main.printSpeed")}:</span>
          {(
            [
              [0.5, "main.printSlow"],
              [1, "main.printNormal"],
              [2, "main.printFast"],
            ] as const
          ).map(([v, key]) => (
            <button
              key={key}
              onClick={() => onPrintSpeedChange(v)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                printSpeed === v
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
      <ToggleRow
        label={t("main.streamCaret")}
        desc={t("main.streamCaretDesc")}
        on={streamCaret}
        onChange={onStreamCaretChange}
      />
      </Group>
      <Group title={t("main.g3")} desc={t("main.g3Desc")}>
      <Row
        label={t("main.quickEntry")}
        desc={t("main.quickEntryDesc")}
        value=""
        extra={
          <button
            onClick={() => setQeRecording(true)}
            className={`min-w-36 rounded-lg border px-3 py-2 text-xs outline-none transition-colors ${
              qeRecording
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line bg-halo-surface text-halo-text hover:border-halo-muted/50"
            }`}
          >
            {qeRecording ? t("main.quickEntryRecording") : prettyQuickentryCombo(qeBind)}
          </button>
        }
      />
      <Row
        label={t("dictation.title")}
        desc={dictDesc}
        value=""
        extra={
          <div className="flex gap-2">
            <button
              onClick={downloadDictModel}
              disabled={dictBusy || dictStatus?.downloading === true}
              title={dictStatus?.modelExists ? t("dictation.modelReady") : undefined}
              className="rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:opacity-50"
            >
              {dictStatus?.downloading
                ? t("dictation.downloading")
                : dictStatus?.modelExists
                  ? t("dictation.modelReady")
                  : t("dictation.downloadModel")}
            </button>
            <button
              onClick={pickDictCli}
              title={dictStatus?.cliPath ?? undefined}
              className="rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("dictation.pickCli")}
            </button>
          </div>
        }
      />
      <Row
        label={t("dictation.micLabel")}
        desc={t("dictation.micDesc")}
        value=""
        extra={
          <Dropdown
            value={micId}
            options={[
              { value: "", label: t("dictation.micDefault") },
              ...mics.map((d, i) => ({
                value: d.deviceId,
                label: d.label || t("dictation.micUnnamed", { n: String(i + 1) }),
              })),
            ]}
            onSelect={pickMic}
            className="w-60"
          />
        }
      />
      {/* ---------- Voice Wake («Jarvis-режим») ---------- */}
      <ToggleRow
        label={t("voice.title")}
        desc={t("voice.desc")}
        on={voice.wake}
        onChange={(v) => onVoiceChange({ wake: v })}
      />
      {voice.wake && dictStatus && !dictStatus.cliFound && (
        <p className="-mt-1 px-3.5 text-[0.625rem] leading-relaxed text-amber-400">
          {t("voice.needCli")}
        </p>
      )}
      {voice.wake && (
        <>
          <Row
            label={t("voice.modelLabel")}
            desc={t("voice.modelDesc")}
            value=""
            extra={
              <div className="flex items-center gap-2">
                <Dropdown
                  value={voice.model}
                  options={(Object.keys(VOICE_MODEL_LABELS) as WakeModel[]).map((m) => ({
                    value: m,
                    label: VOICE_MODEL_LABELS[m],
                  }))}
                  onSelect={(m) => {
                    if (m === "hey_jarvis" || m === "hey_mycroft") onVoiceChange({ model: m });
                  }}
                  className="w-44"
                />
                <button
                  onClick={downloadVoiceModels}
                  disabled={voiceBusy || voiceStatusState?.downloading === true}
                  title={voiceModelsReady ? t("voice.modelsReady") : undefined}
                  className="shrink-0 rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:opacity-50"
                >
                  {voiceStatusState?.downloading
                    ? t("voice.downloadingBtn")
                    : voiceModelsReady
                      ? t("voice.modelsReady")
                      : t("voice.download")}
                </button>
              </div>
            }
          />
          <Row
            label={t("voice.threshold")}
            desc={t("voice.thresholdDesc")}
            value=""
            extra={
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.3}
                  max={0.9}
                  step={0.05}
                  value={voice.threshold}
                  onChange={(e) => onVoiceChange({ threshold: Number(e.target.value) })}
                  className="w-36 accent-[var(--halo-accent)]"
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-halo-muted">
                  {voice.threshold.toFixed(2)}
                </span>
              </div>
            }
          />
          {/* Гейт isWindows: бекенд (SAPI) вне Windows вернёт Err, а тумблер
              с молча гаснущим индикатором обманывал бы (паттерн кнопки TTS) */}
          {isWindows() && (
            <ToggleRow
              label={t("voice.ttsReply")}
              desc={t("voice.ttsReplyDesc")}
              on={voice.ttsReply}
              onChange={(v) => onVoiceChange({ ttsReply: v })}
            />
          )}
          {isWindows() && (
            <Row
              label={t("voice.outputLabel")}
              desc={t("voice.outputDesc")}
              value=""
              extra={
                <Dropdown
                  value={audioOut}
                  options={[
                    { value: "", label: t("voice.outputDefault") },
                    ...audioDevices.map((d) => ({ value: d, label: d })),
                  ]}
                  onSelect={(d) => {
                    setAudioOut(d);
                    // Ключ — из tts.ts: независимые литералы молча
                    // расходились бы при переименовании
                    localStorage.setItem(AUDIO_OUTPUT_KEY, d);
                  }}
                  className="w-64"
                />
              }
            />
          )}
        </>
      )}
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
              {t(snd.labelKey)}
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
              <XSmallIcon />
            </button>
          )}
        </div>
      )}
      {/* Звуки прогона: фоновая обратная связь, пока приложение открыто.
          Мастер-тумблер + три события; тембр — из выбора уведомлений выше,
          свой пикер сознательно не дублируем. По умолчанию всё выключено */}
      <ToggleRow
        label={t("main.runSounds")}
        desc={t("main.runSoundsDesc")}
        on={
          runSoundPrefs.complete || runSoundPrefs.confirm || runSoundPrefs.error
        }
        onChange={(v) =>
          onRunSoundPrefsChange({ complete: v, confirm: v, error: v })
        }
      />
      {(runSoundPrefs.complete ||
        runSoundPrefs.confirm ||
        runSoundPrefs.error) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
          {(
            [
              ["complete", "main.runSoundComplete"],
              ["confirm", "main.runSoundConfirm"],
              ["error", "main.runSoundError"],
            ] as const
          ).map(([event, key]) => (
            <button
              key={event}
              onClick={() => {
                const next = !runSoundPrefs[event];
                onRunSoundPrefsChange({ ...runSoundPrefs, [event]: next });
                // Прослушка при включении — сразу понятно, как звучит
                if (next) playSound(notifyPrefs.sound);
              }}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                runSoundPrefs[event]
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
      <ToggleRow
        label={t("main.askAutoContinue")}
        desc={t("main.askAutoContinueDesc")}
        on={askAutoContinue}
        onChange={onAskAutoContinueChange}
      />
      <ToggleRow
        label={t("main.browserPanel")}
        desc={t("main.browserPanelDesc")}
        on={browserPanel}
        onChange={onBrowserPanelChange}
      />
      <ToggleRow
        label={t("main.autoArchive")}
        desc={t("main.autoArchiveDesc")}
        on={autoArchive}
        onChange={onAutoArchiveChange}
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
      </Group>
      <Group title={t("main.g4")} desc={t("main.g4Desc")} gap="space-y-3">
      <ToggleRow
        label={t("git.autocommitTitle")}
        desc={t("git.autocommitDesc")}
        on={gitAutocommit}
        onChange={onGitAutocommitChange}
      />
      <ToggleRow
        label={t("main.hardMode")}
        desc={t("main.hardModeDesc")}
        on={hardMode}
        onChange={onHardModeChange}
      />
      {/* Hard Limit: прерывание задачи при превышении лимитов расхода */}
      <HardLimitSection limits={limits} onChange={onLimitsChange} />
      {/* Импорт истории из чужих экспортов (ChatGPT / Gemini Takeout) */}
      <div className="rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("import.externalTitle")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("import.externalHint")}
        </p>
        <button
          onClick={() => {
            void (async () => {
              try {
                const path = await pickJsonFile();
                if (!path) return;
                const raw = await settingsImportRead(path);
                const imported = [
                  ...parseChatGptExport(raw),
                  ...parseGeminiExport(raw),
                ];
                if (imported.length === 0) {
                  window.alert(t("import.externalNone"));
                  return;
                }
                onImportSessions(imported);
                window.alert(t("import.externalDone", { n: imported.length }));
              } catch (e) {
                window.alert(String(e));
              }
            })();
          }}
          className="mt-2 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/60 hover:text-halo-accent"
        >
          {t("import.externalBtn")}
        </button>
      </div>
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
            onClick={onExportChats}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("export.chatsBtn")}
          </button>
          <button
            onClick={async () => {
              try {
                const path = await pickJsonFile();
                if (!path) return;
                if (!window.confirm(t("main.importConfirm"))) return;
                // settings_import_read отдаёт сырой JSON (см. api.ts): форма
                // wrapper-а — только у нашего экспорта, сужаем на месте
                const data = (await settingsImportRead(path)) as {
                  files?: Record<string, unknown>;
                  local?: Record<string, string>;
                };
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
                // Кастомный CSS из чужого файла применяется как есть
                // (<style id="halo-custom-css">, img-src допускает https):
                // тот же класс честного confirm, что у исполняемых конфигов
                // выше — асимметрии «hooks/mcp спрашиваем, CSS нет» больше нет
                // (аудит A5-6)
                const css = data.local?.["haloui-custom-css"];
                if (typeof css === "string" && css.trim()) {
                  if (
                    !window.confirm(
                      t("main.importCssWarn", { chars: String(css.length) }),
                    )
                  )
                    return;
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
      {/* Хранилище: размеры каталогов appdata. Звуки/шрифты чистятся
          по-штучно в своих секциях — кнопок очистки у них нет */}
      {stats && (
        <div className="rounded-xl border border-halo-line px-3.5 py-3">
          <p className="text-sm text-halo-text">{t("main.storage")}</p>
          <div className="mt-1.5 px-1.5">
            <StorageRow label={t("main.storageConfig")} bytes={stats.config} lang={lang} />
            <StorageRow
              label={t("main.storageCheckpoints")}
              bytes={stats.checkpoints}
              lang={lang}
              cleanLabel={t("main.storageClean")}
              confirmLabel={t("main.storageCleanConfirm")}
              confirm={confirmKind === "checkpoints"}
              onClean={() => void cleanStorage("checkpoints")}
            />
            <StorageRow
              label={t("main.storageImages")}
              bytes={stats.images}
              lang={lang}
              cleanLabel={t("main.storageClean")}
              confirmLabel={t("main.storageCleanConfirm")}
              confirm={confirmKind === "images"}
              onClean={() => void cleanStorage("images")}
            />
            <StorageRow label={t("main.storageSounds")} bytes={stats.sounds} lang={lang} />
            <StorageRow label={t("main.storageFonts")} bytes={stats.fonts} lang={lang} />
          </div>
        </div>
      )}
      </Group>
    </div>
  );
}

/**
 * Список исполняемых конфигов во входном файле импорта: команды хуков,
 * команды запуска MCP/LSP-серверов, путь llama-server (gguf.json).
 * null — исполняемых конфигов нет. Используется для явного подтверждения
 * перед импортом (защита от RCE через импорт «поделенного конфига»).
 * КОНТРАКТ: зеркалит EXECUTABLE_CONFIGS в settings.rs (settings_write_all) —
 * новый конфиг с командой/бинарем обязан попадать в оба списка.
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
  // lsp.json: {servers: [{extensions, command, args}]} (camelCase, lsp.rs)
  const lsp = files["lsp.json"] as
    | { servers?: Array<{ command?: unknown; args?: unknown }> }
    | undefined;
  if (Array.isArray(lsp?.servers)) {
    for (const s of lsp.servers) {
      if (s && typeof s.command === "string" && s.command.trim() !== "") {
        const args = Array.isArray(s.args) ? s.args.join(" ") : "";
        lines.push(`• lsp: ${s.command}${args ? ` ${args}` : ""}`);
      }
    }
  }
  // gguf.json: llama_server_path спавнится resolve_llama_server (конфиг-first)
  const ggufPath = (
    files["gguf.json"] as { llama_server_path?: unknown } | undefined
  )?.llama_server_path;
  if (typeof ggufPath === "string" && ggufPath.trim() !== "") {
    lines.push(`• gguf (llama-server path): ${ggufPath}`);
  }
  if (lines.length === 0) return null;
  return lines.slice(0, 20).join("\n");
}
