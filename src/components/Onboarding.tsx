import { useState } from "react";
import NocturnMark from "./NocturnMark";
import { useLang, useLangSetter, type Lang } from "../locales";
import { ACCENT_PRESETS } from "../appearance";
import { PROVIDERS, testConnection, type ApiSettings } from "../api";
import type { Theme } from "../types";

/**
 * Онбординг первого запуска: язык → оформление → API-ключ. Без регистрации —
 * всё локально. «Пропустить всё» закрывает визард, не сохранив ничего.
 * Язык и оформление применяются сразу (живое превью через колбэки App),
 * API-ключ сохраняет App в settings.json по «Готово».
 */
export interface OnboardingResult {
  /** null — «Пропустить всё» */
  settings: ApiSettings | null;
}

const LANGS: { id: Lang; label: string }[] = [
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
  { id: "ja", label: "日本語" },
];

const tile = (active: boolean) =>
  `rounded-xl border px-3 py-2.5 text-sm transition-colors ${
    active
      ? "border-halo-accent bg-halo-accent/10 text-halo-text"
      : "border-halo-line text-halo-muted hover:border-halo-accent/40 hover:text-halo-text"
  }`;

const inputCls =
  "w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60";

export default function Onboarding({
  theme,
  onTheme,
  onAccent,
  onFinish,
}: {
  theme: Theme;
  /** клик по плитке — тема меняется сразу во всём приложении */
  onTheme: (t: Theme) => void;
  /** клик по свотчу — акцент применяется сразу */
  onAccent: (hex: string) => void;
  onFinish: (r: OnboardingResult) => void;
}) {
  const { t, lang } = useLang();
  const setLang = useLangSetter();
  const [step, setStep] = useState(0); // 0 язык · 1 оформление · 2 API
  const [provider, setProvider] = useState(PROVIDERS[0]?.id ?? "custom");
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0]?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const finish = (settings: ApiSettings | null) => onFinish({ settings });

  const pickProvider = (id: string) => {
    setProvider(id);
    const preset = PROVIDERS.find((p) => p.id === id);
    if (preset) setBaseUrl(preset.baseUrl);
  };

  const check = async () => {
    setChecking(true);
    setCheckMsg(null);
    try {
      const list = await testConnection(baseUrl.trim(), apiKey.trim());
      setModels(list.map((m) => m.id));
      setCheckMsg({ ok: true, text: t("onb.checkOk", { n: list.length }) });
    } catch (e) {
      setCheckMsg({ ok: false, text: String(e) });
    } finally {
      setChecking(false);
    }
  };

  const done = () =>
    finish({
      api_key: apiKey.trim(),
      base_url: baseUrl.trim(),
      model: model.trim() || models[0] || "",
      provider,
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-halo-bg">
      {/* Призрачный логотип фоном — как в CryptoGate */}
      <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center opacity-[0.05]">
        <NocturnMark size={420} />
      </div>

      <div className="glass-pane anim-pop relative z-10 flex w-full max-w-md flex-col rounded-2xl border border-halo-line bg-halo-deep/90 p-7 shadow-2xl">
        <div className="absolute right-5 top-5 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`size-1.5 rounded-full transition-colors ${
                i === step ? "bg-halo-accent" : "bg-halo-muted/30"
              }`}
            />
          ))}
        </div>
        <span className="text-halo-accent">
          <NocturnMark size={36} />
        </span>

        {step === 0 && (
          <>
            <h2 className="mt-4 text-lg font-medium text-halo-text">
              {t("onb.welcome")}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-halo-muted">
              {t("onb.welcomeSub")}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {LANGS.map((l) => (
                <button key={l.id} onClick={() => setLang(l.id)} className={tile(lang === l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="mt-4 text-lg font-medium text-halo-text">
              {t("onb.lookTitle")}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-halo-muted">
              {t("onb.lookSub")}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button onClick={() => onTheme("dark")} className={tile(theme === "dark")}>
                {t("onb.dark")}
              </button>
              <button onClick={() => onTheme("light")} className={tile(theme === "light")}>
                {t("onb.light")}
              </button>
            </div>
            <p className="mt-4 text-xs text-halo-muted">{t("onb.accent")}</p>
            <div className="mt-2 flex gap-2">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.hex}
                  onClick={() => onAccent(p.hex)}
                  title={p.hex}
                  className="size-7 rounded-full border border-white/20 transition-transform hover:scale-110"
                  style={{ backgroundColor: p.hex }}
                />
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="mt-4 text-lg font-medium text-halo-text">
              {t("onb.apiTitle")}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-halo-muted">
              {t("onb.apiSub")}
            </p>
            <label className="mt-4 block text-xs text-halo-muted">
              {t("onb.provider")}
            </label>
            <select
              value={provider}
              onChange={(e) => pickProvider(e.target.value)}
              className={`mt-1 ${inputCls}`}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">{t("onb.custom")}</option>
            </select>
            <label className="mt-2.5 block text-xs text-halo-muted">
              {t("onb.baseUrl")}
            </label>
            <input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setProvider("custom");
              }}
              placeholder="https://api.example.com/v1"
              className={`mt-1 ${inputCls}`}
            />
            <label className="mt-2.5 block text-xs text-halo-muted">
              {t("onb.apiKey")}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              className={`mt-1 ${inputCls}`}
            />
            <div className="mt-2.5 flex gap-2">
              <div className="min-w-0 flex-1">
                <label className="block text-xs text-halo-muted">
                  {t("onb.model")}
                </label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list="onb-models"
                  placeholder="…"
                  className={`mt-1 ${inputCls}`}
                />
                <datalist id="onb-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <button
                onClick={() => void check()}
                disabled={checking || !baseUrl.trim()}
                className="mt-[1.25rem] shrink-0 rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:opacity-50"
              >
                {checking ? t("onb.checking") : t("onb.check")}
              </button>
            </div>
            {checkMsg && (
              <p
                className={`mt-2 break-all text-xs ${
                  checkMsg.ok ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {checkMsg.text}
              </p>
            )}
          </>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => finish(null)}
            className="text-xs text-halo-muted transition-colors hover:text-halo-text"
          >
            {t("onb.skip")}
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded-lg border border-halo-line px-3.5 py-2 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                {t("onb.back")}
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep(step + 1)}
                className="rounded-lg bg-halo-accent px-4 py-2 text-xs font-medium text-halo-on-accent shadow-sm transition-colors hover:bg-halo-accent-deep"
              >
                {t("onb.next")}
              </button>
            ) : (
              <button
                onClick={done}
                className="rounded-lg bg-halo-accent px-4 py-2 text-xs font-medium text-halo-on-accent shadow-sm transition-colors hover:bg-halo-accent-deep"
              >
                {t("onb.done")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
