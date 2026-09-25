import ProviderIcon from "../ProviderIcon";
import { useEffect, useRef, useState } from "react";
import { useLang } from "../../locales";
import type { ApiProfile, ApiSettings, ModelInfo } from "../../api";
import { providerFromBaseUrl, PROVIDERS } from "../../api";

import { MiniCheckIcon, MiniSearchIcon } from "./parts";
import type { ApiStatus } from "./types";

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
  const { t } = useLang();
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [profName, setProfName] = useState("");
  const [profSaved, setProfSaved] = useState(false);
  const [encBusy, setEncBusy] = useState(false);
  const [encError, setEncError] = useState(false);

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
                className={`rounded-full border px-2.5 py-1 text-xs transition-all duration-150 ${
                  active
                    ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
                }`}
              >
                {p.label}
                {p.kind === "anthropic" && (
                  <span className="ml-1 text-[9px] opacity-70">native</span>
                )}
              </button>
            );
          })}
          <button
            onClick={() =>
              onChange({ ...settings, provider: "custom" })
            }
            title={t("api.providerCustom")}
            className={`rounded-full border px-2.5 py-1 text-xs transition-all duration-150 ${
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
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
                  className={`flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs transition-all duration-150 ${
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
                    ✕
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
            {profSaved ? `✓ ${t("api.profileSaved")}` : t("api.profileAdd")}
          </button>
        </div>
      </div>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-halo-muted">
          {t("api.baseUrl")}
        </span>
        <input
          type="text"
          value={settings.base_url}
          onChange={(e) =>
            onChange({
              ...settings,
              base_url: e.target.value,
              provider: providerFromBaseUrl(e.target.value),
            })
          }
          placeholder="https://openrouter.ai/api/v1"
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </label>

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
                      <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[9px] font-medium text-sky-400">
                        vision
                      </span>
                    )}
                    {!m.vision && m.text && (
                      <span className="rounded bg-halo-muted/15 px-1.5 py-0.5 text-[9px] font-medium text-halo-muted">
                        text
                      </span>
                    )}
                    {m.id.endsWith(":free") ? (
                      <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                        free
                      </span>
                    ) : (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
                        paid
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
            className="rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
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
                    <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
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
          className="rounded-lg bg-halo-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
        >
          {saved ? t("api.saved") : t("api.save")}
        </button>
      </div>
    </div>
  );
}

