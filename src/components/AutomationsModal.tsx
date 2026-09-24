/**
 * Автоматизации: запланированные задачи агента.
 * Референс- layout: заголовок + подзаголовок, карточка со списком
 * (или пустым состоянием с кнопкой создания), тумблер «не давать ПК
 * уснуть», сетка шаблонов. Создание — раскрывающаяся форма.
 */

import { useEffect, useState } from "react";
import {
  AUTOMATION_TEMPLATES,
  loadAutomations,
  makeAutomation,
  nextRunAfter,
  saveAutomations,
  type Automation,
  type Schedule,
} from "../automations";
import { keepAwake } from "../api";
import { useLang } from "../locales";

interface AutomationsModalProps {
  open: boolean;
  onClose: () => void;
}

const LS_KEEP_AWAKE = "haloui-keep-awake";
const WEEKDAY_KEYS = [
  "auto.dowSun",
  "auto.dowMon",
  "auto.dowTue",
  "auto.dowWed",
  "auto.dowThu",
  "auto.dowFri",
  "auto.dowSat",
];

export default function AutomationsModal({
  open,
  onClose,
}: AutomationsModalProps) {
  const { t, lang } = useLang();
  const [items, setItems] = useState<Automation[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"daily" | "weekdays" | "weekly" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [minutes, setMinutes] = useState(60);
  const [keepAwakeOn, setKeepAwakeOn] = useState(
    () => localStorage.getItem(LS_KEEP_AWAKE) === "1",
  );
  // Раскрытая история запусков (id автоматизации)
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // Создание с отчётом в заметки vault
  const [toVaultNew, setToVaultNew] = useState(true);

  useEffect(() => {
    if (open) setItems(loadAutomations());
  }, [open]);

  // Закрытие по Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const persist = (next: Automation[]) => {
    setItems(next);
    saveAutomations(next);
  };

  const create = (n: string, p: string, schedule: Schedule, toVault: boolean) => {
    if (!n.trim() || !p.trim()) return;
    const a = makeAutomation(n.trim(), p.trim(), schedule);
    a.toVault = toVault;
    persist([a, ...loadAutomations()]);
    setFormOpen(false);
    setName("");
    setPrompt("");
  };

  const scheduleText = (a: Automation): string => {
    const s = a.schedule;
    if (s.kind === "interval") return t("auto.everyMinutes", { n: s.minutes });
    if (s.kind === "daily") return t("auto.dailyAt", { time: s.time });
    if (s.kind === "weekdays") return t("auto.weekdaysAt", { time: s.time });
    return t("auto.weeklyAt", {
      day: t(WEEKDAY_KEYS[s.weekday] as never),
      time: s.time,
    });
  };

  const fmtNext = (a: Automation): string => {
    if (!a.enabled) return t("auto.paused");
    const d = new Date(a.nextRunAt);
    const time = d.toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const today = new Date();
    const days = Math.round(
      (new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86400000,
    );
    const when =
      days <= 0
        ? t("auto.today")
        : days === 1
          ? t("auto.tomorrow")
          : d.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", {
              day: "2-digit",
              month: "2-digit",
            });
    return t("auto.nextRun", { when, time });
  };

  const toggleKeepAwake = (v: boolean) => {
    setKeepAwakeOn(v);
    localStorage.setItem(LS_KEEP_AWAKE, v ? "1" : "0");
    void keepAwake(v).catch(() => {});
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop mx-auto my-8 w-full max-w-3xl rounded-2xl border border-halo-line bg-halo-deep p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="mb-1 flex items-start justify-between">
          <h1 className="text-3xl font-bold text-halo-text">
            {t("auto.title")}{" "}
            <span className="text-halo-muted/60">{t("auto.subtitleWord")}</span>
          </h1>
          <button
            onClick={onClose}
            title={t("common.close")}
            className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            ✕
          </button>
        </div>
        <p className="mb-6 text-sm text-halo-muted/80">{t("auto.subtitle")}</p>

        {/* Карточка списка / пустого состояния */}
        <div className="rounded-xl border border-halo-line bg-halo-surface/30 px-4 py-10">
          {items.length === 0 && !formOpen ? (
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-halo-muted/70">{t("auto.empty")}</p>
              <button
                onClick={() => setFormOpen(true)}
                className="flex items-center gap-2 rounded-lg bg-halo-accent px-4 py-2 text-sm font-medium text-halo-on-accent shadow-sm transition-all hover:bg-halo-accent-deep active:scale-95"
              >
                {t("auto.create")}
                <span className="text-xs">·</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((a) => (
                <div
                  key={a.id}
                  className="group rounded-lg border border-halo-line bg-halo-deep/60 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        persist(
                          items.map((x) =>
                            x.id === a.id
                              ? {
                                  ...x,
                                  enabled: !x.enabled,
                                  nextRunAt: !x.enabled
                                    ? nextRunAfter(x, Date.now())
                                    : x.nextRunAt,
                                }
                              : x,
                          ),
                        )
                      }
                      title={a.enabled ? t("auto.pause") : t("auto.resume")}
                      className={`size-2.5 shrink-0 rounded-full ${
                        a.enabled ? "bg-emerald-400" : "bg-halo-muted/40"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-halo-text">
                        {a.name}
                      </p>
                      <p className="truncate text-xs text-halo-muted/70">
                        {scheduleText(a)} · {fmtNext(a)}
                        {a.runs && a.runs.length > 0 && (
                          <>
                            {" · "}
                            {t("auto.runCount", { n: a.runs.length })}
                          </>
                        )}
                      </p>
                    </div>
                    {/* Отчёт в заметки vault */}
                    <button
                      onClick={() =>
                        persist(
                          items.map((x) =>
                            x.id === a.id ? { ...x, toVault: !x.toVault } : x,
                          ),
                        )
                      }
                      title={t("auto.toVault")}
                      className={`rounded p-1 transition-colors ${
                        a.toVault
                          ? "text-halo-accent"
                          : "text-halo-muted opacity-0 hover:text-halo-text group-hover:opacity-100"
                      }`}
                    >
                      <DocIcon />
                    </button>
                    {/* История запусков */}
                    {(a.runs?.length ?? 0) > 0 && (
                      <button
                        onClick={() =>
                          setHistoryFor((v) => (v === a.id ? null : a.id))
                        }
                        title={t("auto.history")}
                        className={`rounded p-1 transition-colors ${
                          historyFor === a.id
                            ? "text-halo-text"
                            : "text-halo-muted opacity-0 hover:text-halo-text group-hover:opacity-100"
                        }`}
                      >
                        <HistoryIcon />
                      </button>
                    )}
                    <button
                      onClick={() =>
                        persist(items.filter((x) => x.id !== a.id))
                      }
                      title={t("common.close")}
                      className="rounded p-1 text-halo-muted opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                  {/* Раскрывная история последних запусков */}
                  {historyFor === a.id && (
                    <ul className="mt-2 space-y-0.5 border-t border-halo-line pt-2">
                      {[...(a.runs ?? [])].reverse().slice(0, 5).map((ts) => (
                        <li
                          key={ts}
                          className="flex items-center gap-2 px-1 text-xs text-halo-muted"
                        >
                          <span className="size-1.5 rounded-full bg-emerald-400/70" />
                          {new Date(ts).toLocaleString(
                            lang === "ru" ? "ru-RU" : "en-US",
                            { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" },
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {!formOpen && (
                <button
                  onClick={() => setFormOpen(true)}
                  className="mt-2 flex items-center gap-2 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                >
                  + {t("auto.create")}
                </button>
              )}
            </div>
          )}

          {/* Форма создания */}
          {formOpen && (
            <div className="mt-4 space-y-3 rounded-lg border border-halo-line bg-halo-deep/70 p-4 text-left">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("auto.namePh")}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("auto.promptPh")}
                rows={3}
                className="w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                  className="rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-halo-text outline-none"
                >
                  <option value="daily">{t("auto.daily")}</option>
                  <option value="weekdays">{t("auto.weekdays")}</option>
                  <option value="weekly">{t("auto.weekly")}</option>
                  <option value="interval">{t("auto.interval")}</option>
                </select>
                {kind === "weekly" && (
                  <select
                    value={weekday}
                    onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
                    className="rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-halo-text outline-none"
                  >
                    {WEEKDAY_KEYS.map((k, i) => (
                      <option key={k} value={i}>
                        {t(k as never)}
                      </option>
                    ))}
                  </select>
                )}
                {kind !== "interval" ? (
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-halo-text outline-none"
                  />
                ) : (
                  <label className="flex items-center gap-1.5 text-halo-muted">
                    {t("auto.everyMinutes", { n: "" })}
                    <input
                      type="number"
                      min={5}
                      max={10080}
                      value={minutes}
                      onChange={(e) => setMinutes(parseInt(e.target.value, 10) || 60)}
                      className="w-20 rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-halo-text outline-none"
                    />
                  </label>
                )}
                <span className="flex-1" />
                <label className="flex cursor-pointer items-center gap-1.5 text-halo-muted">
                  <input
                    type="checkbox"
                    checked={toVaultNew}
                    onChange={(e) => setToVaultNew(e.target.checked)}
                    className="accent-halo-accent"
                  />
                  {t("auto.toVault")}
                </label>
                <button
                  onClick={() => {
                    const schedule: Schedule =
                      kind === "interval"
                        ? { kind: "interval", minutes }
                        : kind === "weekly"
                          ? { kind: "weekly", weekday, time }
                          : { kind, time };
                    create(name, prompt, schedule, toVaultNew);
                  }}
                  disabled={!name.trim() || !prompt.trim()}
                  className="rounded-lg bg-halo-accent px-3 py-1.5 font-medium text-halo-on-accent transition-all hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("auto.save")}
                </button>
                <button
                  onClick={() => setFormOpen(false)}
                  className="rounded-lg border border-halo-line px-3 py-1.5 text-halo-muted transition-colors hover:text-halo-text"
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Не давать ПК уснуть */}
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-halo-line bg-halo-surface/30 px-4 py-3">
          <span className="text-halo-muted"><InfoIcon /></span>
          <p className="flex-1 text-sm text-halo-muted">{t("auto.keepAwake")}</p>
          <button
            onClick={() => toggleKeepAwake(!keepAwakeOn)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              keepAwakeOn ? "bg-halo-accent" : "bg-halo-muted/30"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
                keepAwakeOn ? "left-4.5" : "left-0.5"
              }`}
            />
          </button>
        </div>

        {/* Шаблоны */}
        <p className="mb-3 mt-6 text-sm font-semibold text-halo-text">
          {t("auto.templates")}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AUTOMATION_TEMPLATES.map((tpl) => (
            <button
              key={tpl.nameKey}
              onClick={() =>
                create(t(tpl.nameKey as never), tpl.prompt, tpl.schedule, true)
              }
              className="rounded-xl border border-halo-line bg-halo-surface/30 p-4 text-left transition-colors hover:border-halo-accent/40 hover:bg-halo-hover/50"
            >
              <p className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-halo-text">
                <span className="text-halo-muted">{tpl.icon === "sun" ? <SunIcon /> : tpl.icon === "zap" ? <ZapIcon /> : tpl.icon === "doc" ? <DocIcon /> : <ListIcon />}</span>
                {t(tpl.nameKey as never)}
              </p>
              <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-halo-muted">
                {t(tpl.descKey as never)}
              </p>
              <p className="text-xs text-halo-muted/70">
                {scheduleText({
                  schedule: tpl.schedule,
                } as Automation)}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5 M12 8h.01" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6l1.4 1.4 M17 17l1.4 1.4 M18.4 5.6L17 7 M7 17l-1.4 1.4" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
