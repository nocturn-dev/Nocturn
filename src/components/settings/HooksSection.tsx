import { useEffect, useRef, useState } from "react";
import { useLang } from "../../locales";
import { type Hook, type HookOutcome, HOOK_EVENTS, hooksLoad, hooksSave, hooksTest } from "../../api";
import { Dropdown, MiniTrashIcon } from "./parts";

const HOOK_EVENT_KEYS = {
  PreToolUse: "hook.event.PreToolUse",
  PostToolUse: "hook.event.PostToolUse",
  UserPromptSubmit: "hook.event.UserPromptSubmit",
  Stop: "hook.event.Stop",
  SessionStart: "hook.event.SessionStart",
} as const;

export function HooksSection() {
  const { t } = useLang();
  const addPreset = async (
    preset:
      | "blockDelete"
      | "beepStop"
      | "blockShell"
      | "blockMcp"
      | "worklog"
      | "gitAdd",
  ) => {
    const presets = {
      // Запрет удаления файлов агентом
      blockDelete: {
        event: "PreToolUse",
        matcher: "fs_delete",
        command: 'echo {"decision":"block","reason":"Удаление файлов запрещено хуком"}',
      },
      // Звук по завершении ответа модели
      beepStop: {
        event: "Stop",
        matcher: "",
        command: "powershell -NoProfile -c [console]::beep(880,250)",
      },
      // Запрет shell-команд (агент без терминала)
      blockShell: {
        event: "PreToolUse",
        matcher: "shell_run",
        command: 'echo {"decision":"block","reason":"Выполнение shell-команд запрещено хуком"}',
      },
      // Запрет MCP-инструментов
      blockMcp: {
        event: "PreToolUse",
        matcher: "mcp__",
        command: 'echo {"decision":"block","reason":"MCP-инструменты отключены хуком"}',
      },
      // Журнал сессий: строка в worklog.txt на старте сессии
      worklog: {
        event: "SessionStart",
        matcher: "",
        command:
          "powershell -NoProfile -c \"Add-Content -Path '$env:USERPROFILE\\nocturn-worklog.txt' -Value (\\\"{0:yyyy-MM-dd HH:mm} session started\\\" -f (Get-Date))\"",
      },
      // Git: авто-индексация файла после правки агентом
      gitAdd: {
        event: "PostToolUse",
        matcher: "fs_write",
        command:
          "powershell -NoProfile -c \"$j=[Console]::In.ReadToEnd()|ConvertFrom-Json; if ($j.arguments.path) { git add $j.arguments.path }\"",
      },
    } as const;
    const p = presets[preset];
    await persist([
      ...hooksRef.current,
      {
        id: `hook-${Date.now().toString(36)}`,
        event: p.event,
        matcher: p.matcher,
        command: p.command,
        timeout: 15,
        enabled: true,
      },
    ]);
  };

  const eventLabel = (ev: string) =>
    t(HOOK_EVENT_KEYS[ev as keyof typeof HOOK_EVENT_KEYS] ?? "hook.event.Stop");
  const [hooks, setHooks] = useState<Hook[]>([]);
  // Ref-зеркало актуального массива: next считаем из него, а не из снапшота
  // state — иначе два быстрых клика подряд перезапишут результат первого
  const hooksRef = useRef<Hook[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Форма добавления
  const [event, setEvent] = useState<string>("PreToolUse");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(30);
  // Тест: id хука → исход
  const [testOut, setTestOut] = useState<Record<string, HookOutcome>>({});
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    hooksLoad()
      .then((f) => {
        hooksRef.current = f.hooks ?? [];
        setHooks(f.hooks ?? []);
      })
      .catch(() => {});
  }, []);

  const persist = async (next: Hook[]) => {
    hooksRef.current = next;
    setHooks(next);
    try {
      await hooksSave({ hooks: next });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const update = async (id: string, patch: Partial<Hook>) => {
    await persist(hooksRef.current.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  };

  const addHook = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    await persist([
      ...hooksRef.current,
      {
        id: `hook-${Date.now().toString(36)}`,
        event,
        matcher: matcher.trim(),
        command: cmd,
        timeout: Math.max(1, timeoutSec || 30),
        enabled: true,
      },
    ]);
    setCommand("");
    setMatcher("");
    setShowAdd(false);
  };

  const runTest = async (h: Hook) => {
    setTestBusy(h.id);
    try {
      const payload = ["PreToolUse", "PostToolUse"].includes(h.event)
        ? { event: h.event, tool: h.matcher || "fs_write", arguments: { path: "demo.txt" } }
        : { event: h.event };
      const out = await hooksTest(h, payload);
      setTestOut((prev) => ({ ...prev, [h.id]: out }));
    } catch (e) {
      setTestOut((prev) => ({
        ...prev,
        [h.id]: {
          id: h.id,
          ran: true,
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: String(e),
          blocked: false,
          reason: "",
          additionalContext: "",
        },
      }));
    } finally {
      setTestBusy(null);
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.hooks")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">{t("hook.desc")}</p>

      {/* Готовые пресеты */}
      {hooks.length === 0 && !showAdd && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-halo-line px-3 py-2.5">
          <span className="text-[11px] text-halo-muted">{t("hook.presets")}:</span>
          {(
            [
              ["blockDelete", "hook.preset.blockDelete"],
              ["blockShell", "hook.preset.blockShell"],
              ["blockMcp", "hook.preset.blockMcp"],
              ["beepStop", "hook.preset.beepStop"],
              ["worklog", "hook.preset.worklog"],
              ["gitAdd", "hook.preset.gitAdd"],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              onClick={() => void addPreset(id)}
              className="rounded-md border border-halo-line px-2 py-1 text-[11px] text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {hooks.length === 0 && !showAdd && (
          <div className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-6 text-center">
            <p className="text-xs text-halo-muted">{t("hook.empty")}</p>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-3 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
            >
              + {t("hook.new")}
            </button>
          </div>
        )}
        {hooks.map((h) => {
          const out = testOut[h.id];
          return (
            <div
              key={h.id}
              className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[10px] text-halo-accent">
                  {eventLabel(h.event)}
                </span>
                {h.matcher && (
                  <code className="shrink-0 font-mono text-[10px] text-halo-muted">
                    {h.matcher}
                  </code>
                )}
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-halo-muted">
                  {h.command}
                </code>
                <span className="shrink-0 text-[10px] text-halo-muted/60">
                  {h.timeout}s
                </span>
                <button
                  onClick={() => void update(h.id, { enabled: !h.enabled })}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    h.enabled
                      ? "border-emerald-400/40 text-emerald-400"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {h.enabled ? t("hook.on") : t("hook.off")}
                </button>
                <button
                  onClick={() => void runTest(h)}
                  disabled={testBusy === h.id}
                  title={t("hook.test")}
                  className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent disabled:opacity-40"
                >
                  {testBusy === h.id ? "…" : t("hook.test")}
                </button>
                <button
                  onClick={() => void persist(hooksRef.current.filter((x) => x.id !== h.id))}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
              {/* Редактирование команды inline. D8: запись на диск по blur/Enter,
                  а не на каждое нажатие клавиши — раньше каждый символ гонял
                  IPC-запись hooks.json (гонки записи, лаг ввода) */}
              <input
                type="text"
                defaultValue={h.command}
                key={h.id + h.command}
                onBlur={(e) => {
                  if (e.target.value !== h.command) {
                    void update(h.id, { command: e.target.value });
                  }
                }}
                onKeyDown={(e) => {
                  // isComposing: энтер подтверждения IME не коммитит команду
                  if (e.key === "Enter" && !e.nativeEvent.isComposing)
                    (e.target as HTMLInputElement).blur();
                }}
                spellCheck={false}
                className="mt-2 w-full rounded-md border border-transparent bg-halo-surface px-2 py-1.5 font-mono text-xs text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
              {out && (
                <div
                  className={`mt-2 space-y-1 rounded-md px-2 py-1.5 font-mono text-[10px] leading-relaxed ${
                    out.blocked
                      ? "bg-red-400/10 text-red-400"
                      : "bg-emerald-400/10 text-emerald-400"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      {t("hook.exit")}: {out.exitCode ?? "—"}
                      {out.timedOut ? ` · ${t("hook.timeoutHit")}` : ""}
                      {out.blocked ? ` · ${t("hook.blockedLabel")}` : ""}
                    </span>
                    {/* Стрелочка назад: скрыть результат теста */}
                    <button
                      onClick={() =>
                        setTestOut((prev) => {
                          const next = { ...prev };
                          delete next[h.id];
                          return next;
                        })
                      }
                      title={t("hook.back")}
                      className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-halo-hover"
                    >
                      ←
                    </button>
                  </div>
                  {out.stdout && <pre className="whitespace-pre-wrap">{out.stdout}</pre>}
                  {out.stderr && <pre className="whitespace-pre-wrap">{out.stderr}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-relaxed text-red-400">
          {error}
        </p>
      )}

      {/* Форма добавления */}
      {showAdd && (
        <div className="mt-4 space-y-3 rounded-xl border border-halo-line p-3">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("hook.eventLabel")}
              </label>
              <Dropdown
                value={event}
                options={HOOK_EVENTS.map((ev: string) => ({ value: ev, label: eventLabel(ev) }))}
                onSelect={setEvent}
                className="w-full"
              />
            </div>
            <div className="w-28">
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("hook.timeout")}
              </label>
              <input
                type="number"
                min={1}
                max={600}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 text-xs text-halo-text outline-none focus:border-halo-accent/60"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
              {t("hook.matcherLabel")}
            </label>
            <input
              type="text"
              value={matcher}
              onChange={(e) => setMatcher(e.target.value)}
              placeholder={t("hook.matcher")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-halo-muted/70">
              {t("hook.matcherHint")}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
              {t("hook.commandLabel")}
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("hook.command")}
              spellCheck={false}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-halo-muted/70">{t("hook.hint")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("prompts.cancel")}
            </button>
            <button
              onClick={() => void addHook()}
              disabled={!command.trim()}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("hook.add")}
            </button>
          </div>
        </div>
      )}
      {!showAdd && hooks.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
          >
            + {t("hook.new")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Раздел «Browser Use»: тумблеры и путь к браузеру */
