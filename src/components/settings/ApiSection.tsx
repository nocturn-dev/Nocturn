import ProviderIcon from "../ProviderIcon";
import { useEffect, useRef, useState } from "react";
import { useLang } from "../../locales";
import type { ApiProfile, ApiSettings, ModelInfo, ColibriStatus, ColibriLocal } from "../../api";
import {
  importProviderToml,
  providerFromBaseUrl,
  PROVIDERS,
  colibriStart,
  colibriStop,
  colibriStatus,
  listenColibriLog,
  loadColibriLocal,
  saveColibriLocal,
} from "../../api";

import { MiniCheckIcon, MiniSearchIcon } from "./parts";
import type { ApiStatus } from "./types";
import { CheckIcon, XSmallIcon } from "../cards/icons";

export function ApiSection({
  settings,
  status,
  profiles,
  activeProfileId,
  onAddProfile,
  onApplyProfile,
  onDeleteProfile,
  onEncryptionToggle,
  ollamaModels,
  onChange,
  onTest,
  onSave,
  onDetectOllama,
  onUseLocalModel,
}: {
  settings: ApiSettings;
  status: ApiStatus;
  profiles: ApiProfile[];
  activeProfileId: string;
  onAddProfile: (name: string) => void;
  onApplyProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onEncryptionToggle: (enable: boolean) => Promise<boolean>;
  ollamaModels: string[] | null;
  onChange: (s: ApiSettings) => void;
  onTest: () => void;
  onSave: () => Promise<void>;
  onDetectOllama: () => void;
  onUseLocalModel: (id: string) => void;
}) {
  // Импорт provider-конфига Codex-стиля (config.toml и подобные, волна
  // «такие API»): парс в Rust, подстановка в текущие настройки
  const [tomlMsg, setTomlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tomlBusy, setTomlBusy] = useState(false);
  const importToml = async () => {
    setTomlBusy(true);
    setTomlMsg(null);
    try {
      const res = await importProviderToml();
      if (!res) return; // диалог отменён
      const a = res.active;
      onChange({
        ...settings,
        base_url: a.base_url,
        // responses → проводной формат Responses API, иначе chat/completions
        provider: a.wire === "responses" ? "openai-responses" : "openai",
        model: res.model || settings.model,
        // $VAR/env-ссылки приходят из Rust пустыми — ключ юзер вставляет сам
        ...(a.token ? { api_key: a.token } : {}),
      });
      setTomlMsg({ ok: true, text: t("api.importTomlOk", { name: a.name || a.key }) });
    } catch (e) {
      setTomlMsg({ ok: false, text: String(e) });
    } finally {
      setTomlBusy(false);
    }
  };

  const { t } = useLang();
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [profName, setProfName] = useState("");
  const [profSaved, setProfSaved] = useState(false);
  const [encBusy, setEncBusy] = useState(false);
  const [encError, setEncError] = useState(false);

  // Colibri: конфиг запуска (localStorage), статус дочернего coli serve, хвост лога
  const [colibri, setColibri] = useState<ColibriLocal>(loadColibriLocal);
  const [cbStatus, setCbStatus] = useState<ColibriStatus>({ running: false });
  const [cbLog, setCbLog] = useState<string[]>([]);
  const [cbError, setCbError] = useState<string | null>(null);
  const [cbBusy, setCbBusy] = useState(false);

  // Статус на открытии раздела: процесс мог завершиться сам
  useEffect(() => {
    void colibriStatus()
      .then(setCbStatus)
      .catch(() => {});
  }, []);
  // Подписка на лог сервера ставится один раз; хвост — 200 строк
  useEffect(() => {
    // StrictMode double-mount: cleanup первого монтирования срабатывает ДО
    // резолва промиса, и первая подписка оставалась жить вечно
    let disposed = false;
    let un: (() => void) | undefined;
    void listenColibriLog((line) => {
      if (disposed) return;
      setCbLog((prev) => [...prev.slice(-199), line]);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const setCbField = (patch: Partial<ColibriLocal>) => {
    const next = { ...colibri, ...patch };
    setColibri(next);
    saveColibriLocal(next);
  };

  const cbStart = async () => {
    setCbBusy(true);
    setCbError(null);
    saveColibriLocal(colibri);
    // Порт из конфига синхронно с base_url соединения (для пресета Colibri)
    if (settings.provider === "colibri") {
      onChange({ ...settings, base_url: `http://localhost:${colibri.port}/v1` });
    }
    try {
      setCbStatus(
        await colibriStart({
          exe: colibri.exe,
          model: settings.model,
          apiKey: settings.api_key,
          args: colibri.args,
        }),
      );
    } catch (e) {
      setCbError(String(e));
    } finally {
      setCbBusy(false);
    }
  };

  const cbStop = async () => {
    setCbBusy(true);
    try {
      setCbStatus(await colibriStop());
    } catch {
      // статус уточнится при следующем открытии раздела
    } finally {
      setCbBusy(false);
    }
  };

  const addProfile = () => {
    onAddProfile(profName);
    setProfName("");
    setProfSaved(true);
    window.setTimeout(() => setProfSaved(false), 2000);
  };
  // D9: автотест соединения срабатывает по blur (и на открытии раздела),
  // а не на каждый keystroke API-ключа: раньше каждый символ после 700 мс
  // улетал сетевым запросом к провайдеру с полным ключом
  const lastTestedRef = useRef<string | null>(null);
  const [focusedSecret, setFocusedSecret] = useState(false);

  const canTest =
    settings.api_key.trim() !== "" && settings.base_url.trim() !== "";
  const testKey = `${settings.api_key.trim()}|${settings.base_url.trim()}`;
  const models: ModelInfo[] = status.models ?? [];
  const filtered = modelQuery.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(modelQuery.toLowerCase()))
    : models;

  // Тест по окончании ввода: blur ключа/URL (или открытие раздела — 0 мс)
  useEffect(() => {
    if (!canTest || focusedSecret) return;
    if (lastTestedRef.current === testKey) return;
    const delay = lastTestedRef.current === null ? 0 : 300;
    const t = window.setTimeout(() => {
      lastTestedRef.current = testKey;
      onTest();
    }, delay);
    return () => window.clearTimeout(t);
  }, [testKey, canTest, onTest, focusedSecret]);

  const handleSave = async () => {
    await onSave();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("settings.api")}</h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("api.desc")}
      </p>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-halo-muted">
          {t("api.key")}
        </span>
        <p className="mb-2 text-xs leading-relaxed text-halo-muted">
          {t("api.keyDesc")}
        </p>
        <input
          type="password"
          value={settings.api_key}
          onChange={(e) => onChange({ ...settings, api_key: e.target.value })}
          onFocus={() => setFocusedSecret(true)}
          onBlur={() => setFocusedSecret(false)}
          placeholder={t("api.keyPh")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </label>

      {/* Провайдер: клик подставляет Base URL, остаётся вписать только ключ */}
      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-medium text-halo-muted">
          {t("api.provider")}
        </span>
        <p className="mb-2 text-xs leading-relaxed text-halo-muted">
          {t("api.providerDesc")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => {
            const active = settings.provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() =>
                  onChange({ ...settings, base_url: p.baseUrl, provider: p.id })
                }
                title={p.baseUrl}
                className={`rounded-full border px-2.5 py-1 text-xs transition duration-150 ${
                  active
                    ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
                }`}
              >
                {p.label}
                {p.kind === "anthropic" && (
                  <span className="ml-1 text-[0.5625rem] opacity-70">{t("api.nativeBadge")}</span>
                )}
              </button>
            );
          })}
          <button
            onClick={() =>
              onChange({ ...settings, provider: "custom" })
            }
            title={t("api.providerCustom")}
            className={`rounded-full border px-2.5 py-1 text-xs transition duration-150 ${
              settings.provider === "custom"
                ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
            }`}
          >
            {t("api.providerCustom")}
          </button>
        </div>
      </div>

      {/* Шифрование ключей: мастер-ключ в Credential Manager */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("api.encKeys")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("api.encKeysDesc")}
          </p>
        </div>
        <button
          onClick={async () => {
            setEncBusy(true);
            const ok = await onEncryptionToggle(!settings.encrypt_keys);
            setEncBusy(false);
            if (!ok) setEncError(true);
            else setEncError(false);
          }}
          disabled={encBusy}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            settings.encrypt_keys ? "bg-halo-accent" : "bg-halo-line"
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              settings.encrypt_keys ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      {encError && (
        <p className="mb-3 text-xs text-red-400">{t("api.encError")}</p>
      )}

      {/* Профили ключей: сохранить текущую связку и переключаться кликом */}
      <div className="mb-4 rounded-xl border border-halo-line p-3">
        <p className="text-sm font-medium text-halo-text">{t("api.profiles")}</p>
        <p className="mb-2 text-xs leading-relaxed text-halo-muted">
          {t("api.profilesSub")}
        </p>
        {profiles.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {profiles.map((p) => {
              const active = activeProfileId === p.id;
              return (
                <span
                  key={p.id}
                  className={`flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs transition duration-150 ${
                    active
                      ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
                  }`}
                >
                  <button
                    onClick={() => onApplyProfile(p.id)}
                    title={`${p.base_url} · ${p.model || "?"}`}
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => onDeleteProfile(p.id)}
                    title={p.name}
                    className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-red-400/20 hover:text-red-400"
                  >
                    <XSmallIcon />
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="mb-2 text-xs text-halo-muted/70">
            {t("api.profilesEmpty")}
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={profName}
            onChange={(e) => setProfName(e.target.value)}
            placeholder={t("api.profileName")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <button
            onClick={addProfile}
            disabled={!canTest}
            title={canTest ? undefined : t("api.key")}
            className="shrink-0 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {profSaved ? <><CheckIcon /> {t("api.profileSaved")}</> : t("api.profileAdd")}
          </button>
        </div>
      </div>

      <label className="mb-4 block">
        <span className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-halo-muted">{t("api.baseUrl")}</span>
          <button
            type="button"
            onClick={() => void importToml()}
            disabled={tomlBusy}
            title={t("api.importToml")}
            className="shrink-0 rounded-full border border-halo-line px-2 py-0.5 text-[0.6875rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {tomlBusy ? "…" : t("api.importToml")}
          </button>
        </span>
        <input
          type="text"
          value={settings.base_url}
          onChange={(e) => {
            const base_url = e.target.value;
            onChange({
              ...settings,
              base_url,
              // openai-responses — проводной формат (импорт config.toml),
              // providerFromBaseUrl его не выводит: без гарда один keystroke
              // в Base URL молча возвращал чат-провод и Responses-провайдер
              // ломался на /chat/completions (аудит A5-1). Смена провода —
              // через чипы пресетов, не через правку URL
              provider:
                settings.provider === "openai-responses"
                  ? settings.provider
                  : providerFromBaseUrl(base_url),
            });
          }}
          placeholder="https://openrouter.ai/api/v1"
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </label>
      {tomlMsg && (
        <p
          className={`-mt-2 mb-3 text-xs ${tomlMsg.ok ? "text-emerald-400" : "text-red-400"}`}
        >
          {tomlMsg.text}
        </p>
      )}

      {/* Выбор модели: список после автопроверки, иначе ручной ввод */}
      {models.length > 0 && !manual ? (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-halo-muted">
              {t("api.found", { n: models.length })}
            </span>
            <button
              onClick={() => setManual(true)}
              className="text-xs text-halo-accent transition-colors hover:text-halo-accent-deep"
            >
              {t("api.manual")}
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-halo-line bg-halo-surface px-3 py-2">
            <span className="text-halo-muted">
              <MiniSearchIcon />
            </span>
            <input
              type="text"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={t("api.filterPh")}
              className="flex-1 bg-transparent text-sm text-halo-text outline-none placeholder:text-halo-muted/60"
            />
          </div>
          {/* Выбранная модель — всегда на виду */}
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-halo-accent/40 bg-halo-accent/10 px-3 py-2">
            <span className="text-halo-accent">
              <MiniCheckIcon />
            </span>
            <span className="text-xs text-halo-muted">{t("api.selected")}</span>
            <ProviderIcon modelId={settings.model} size={14} />
            <span className="truncate font-mono text-xs text-halo-text">
              {settings.model || t("api.selectedNone")}
            </span>
          </div>
          <div className="scroll-slim max-h-56 overflow-y-auto rounded-lg border border-halo-line bg-halo-surface/50">
            {filtered.slice(0, 120).map((m) => {
              const selected = m.id === settings.model;
              return (
                <button
                  key={m.id}
                  onClick={() => onChange({ ...settings, model: m.id })}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                  }`}
                >
                  {/* Логотип провайдера (буквенный фолбэк, если бренда нет) */}
                  <ProviderIcon modelId={m.id} size={18} />
                  <span className="truncate font-mono">{m.id}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {m.vision && (
                      <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-sky-400">
                        {t("api.visionBadge")}
                      </span>
                    )}
                    {!m.vision && m.text && (
                      <span className="rounded bg-halo-muted/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-halo-muted">
                        {t("api.textBadge")}
                      </span>
                    )}
                    {m.id.endsWith(":free") ? (
                      <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-400">
                        {t("api.freeBadge")}
                      </span>
                    ) : (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-400">
                        {t("api.paidBadge")}
                      </span>
                    )}
                    {selected && <MiniCheckIcon />}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-center text-xs text-halo-muted">
                {t("common.nothingFound")}
              </p>
            )}
          </div>
        </div>
      ) : (
        <label className="mb-4 block">
          <span className="mb-1 flex items-center justify-between text-xs font-medium text-halo-muted">
            {t("api.model")}
            {models.length > 0 && (
              <button
                onClick={() => setManual(false)}
                className="text-halo-accent transition-colors hover:text-halo-accent-deep"
              >
                {t("api.fromList")}
              </button>
            )}
          </span>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
            placeholder={t("api.modelManualPh")}
            className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        </label>
      )}

      {/* Fallback-модель: при исчерпании ретраев на 429/5xx прогон повторяется
          на ней (необязательное поле) */}
      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-halo-muted">
          {t("api.fallbackModel")}
        </span>
        <input
          type="text"
          value={settings.fallback_model ?? ""}
          onChange={(e) =>
            onChange({
              ...settings,
              fallback_model: e.target.value.trim() || undefined,
            })
          }
          placeholder={t("api.fallbackModelPh")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <span className="mt-1 block text-[0.6875rem] leading-relaxed text-halo-muted/70">
          {t("api.fallbackModelHint")}
        </span>
      </label>

      {/* Локальные модели (Ollama) */}
      <div className="mb-4 rounded-xl border border-halo-line p-3">
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${
              ollamaModels !== null
                ? "bg-emerald-400"
                : "bg-halo-muted/40"
            }`}
          />
          <span className="text-sm font-medium text-halo-text">
            {t("ollama.title")}
          </span>
          <span className="flex-1" />
          <button
            onClick={onDetectOllama}
            className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("ollama.again")}
          </button>
        </div>
        {ollamaModels === null ? (
          <p className="text-xs leading-relaxed text-halo-muted">
            {t("ollama.missing", { url: "http://localhost:11434" })}
          </p>
        ) : ollamaModels.length === 0 ? (
          <p className="text-xs leading-relaxed text-halo-muted">
            {t("ollama.noModels")}
          </p>
        ) : (
          <div className="scroll-slim max-h-40 overflow-y-auto">
            {ollamaModels.map((id) => {
              const selected =
                settings.model === id &&
                settings.base_url.includes("localhost");
              return (
                <button
                  key={id}
                  onClick={() => onUseLocalModel(id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                  }`}
                >
                  <span className="truncate font-mono">{id}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-400">
                      {t("ollama.badge")}
                    </span>
                    {selected && <MiniCheckIcon />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Локальный движок Colibri (coli serve): запуск прямо из приложения */}
      <div className="mb-4 rounded-xl border border-halo-line p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${
              cbStatus.running ? "bg-emerald-400" : "bg-halo-muted/40"
            }`}
          />
          <span className="text-sm font-medium text-halo-text">
            {t("api.colibriTitle")}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => void (cbStatus.running ? cbStop() : cbStart())}
            disabled={cbBusy}
            className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
          >
            {cbStatus.running ? t("api.colibriStop") : t("api.colibriStart")}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-halo-muted">
          {t("api.colibriHint")}
        </p>
        <div className="mt-2 flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-xs text-halo-muted">
              {t("api.colibriExe")}
            </span>
            <input
              type="text"
              value={colibri.exe}
              onChange={(e) => setCbField({ exe: e.target.value })}
              placeholder="coli"
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </label>
          <label className="flex w-20 shrink-0 flex-col gap-1">
            <span className="truncate text-xs text-halo-muted">
              {t("api.colibriPort")}
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              value={colibri.port}
              onChange={(e) => {
                const port = Number(e.target.value);
                setCbField({ port: Number.isFinite(port) ? port : 8000 });
                if (settings.provider === "colibri") {
                  onChange({ ...settings, base_url: `http://localhost:${port}/v1` });
                }
              }}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none transition-colors focus:border-halo-accent/60"
            />
          </label>
        </div>
        <label className="mt-2 flex flex-col gap-1">
          <span className="truncate text-xs text-halo-muted">
            {t("api.colibriArgs")}
          </span>
          <input
            type="text"
            value={colibri.args}
            onChange={(e) => setCbField({ args: e.target.value })}
            placeholder="--port 8100 --flag"
            className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        </label>
        <p className="mt-2 text-xs text-halo-muted">
          {cbStatus.running
            ? t("api.colibriRunning", { pid: cbStatus.pid ?? 0 })
            : t("api.colibriStopped")}
        </p>
        {cbError && (
          <p className="mt-1 break-all text-xs text-red-400">{cbError}</p>
        )}
        {cbLog.length > 0 && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-halo-muted">
              {t("api.colibriLog")}
            </summary>
            <pre className="scroll-slim mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-halo-deep/60 p-2 font-mono text-[0.625rem] leading-relaxed text-halo-muted">
              {cbLog.slice(-100).join("\n")}
            </pre>
          </details>
        )}
      </div>

      {/* Статус проверки */}
      {status.kind === "checking" && (
        <p className="mb-3 flex items-center gap-2 text-xs text-halo-muted">
          <span className="typing-dot size-1.5 rounded-full bg-halo-accent" />
          {t("api.checking")}
        </p>
      )}
      {status.kind === "ok" && (
        <p className="mb-3 flex items-center gap-2 text-xs text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          {status.message}
        </p>
      )}
      {status.kind === "error" && (
        <p className="mb-3 flex items-start gap-2 text-xs text-red-400">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-red-400" />
          {status.message}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            lastTestedRef.current = null;
            onTest();
          }}
          disabled={!canTest || status.kind === "checking"}
          className="rounded-lg border border-halo-line px-3.5 py-2 text-sm text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("api.refresh")}
        </button>
        <button
          onClick={handleSave}
          className="rounded-lg bg-halo-accent px-3.5 py-2 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep"
        >
          {saved ? t("api.saved") : t("api.save")}
        </button>
      </div>
    </div>
  );
}

