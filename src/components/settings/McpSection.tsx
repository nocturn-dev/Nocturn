import { useEffect, useRef, useState } from "react";
import { useLang } from "../../locales";
import { type McpServerCfg, type McpServerStatus, mcpListServers, mcpSaveServers, mcpConnect, mcpDisconnect, mcpStatus, invalidateToolSchemas } from "../../api";
import { MiniTrashIcon } from "./parts";

export function McpSection() {
  const { t } = useLang();
  const [servers, setServers] = useState<McpServerCfg[]>([]);
  // Ref-зеркало актуального массива: next считаем из него, а не из снапшота
  // state — иначе два быстрых клика подряд перезапишут результат первого
  const serversRef = useRef<McpServerCfg[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  // Удалённый MCP (streamable HTTP): транспорт, endpoint, заголовки-токены
  const [remote, setRemote] = useState(false);
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * Разбор JSON-конфига в формате Claude Desktop / ZCode:
   * {"mcpServers": {"name": {command, args, env}}} или {"name": {…}}.
   * Неизвестные поля (type, timeout, protocolVersion…) игнорируются.
   */
  const parseImportText = (raw: string): McpServerCfg[] | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const map: unknown = (parsed as Record<string, unknown>).mcpServers ?? parsed;
    if (typeof map !== "object" || map === null) return null;
    const out: McpServerCfg[] = [];
    for (const [srvName, rawCfg] of Object.entries(map as Record<string, unknown>)) {
      if (typeof rawCfg !== "object" || rawCfg === null) continue;
      const cfg = rawCfg as Record<string, unknown>;
      // Удалённый сервер: {"type":"http"/"sse","url":...,"headers":{...}}
      const ctype = typeof cfg.type === "string" ? cfg.type : "";
      const rurl = typeof cfg.url === "string" ? cfg.url.trim() : "";
      if (!cfg.command && (ctype === "http" || ctype === "sse") && rurl) {
        const rheaders: Record<string, string> = {};
        if (typeof cfg.headers === "object" && cfg.headers !== null) {
          for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
            if (typeof v === "string") rheaders[k] = v;
          }
        }
        out.push({
          name: srvName,
          command: "",
          args: [],
          env: {},
          enabled: true,
          transport: ctype === "sse" ? "sse" : "http",
          url: rurl,
          headers: rheaders,
        });
        continue;
      }
      if (typeof cfg.command !== "string" || !cfg.command.trim()) continue;
      const env: Record<string, string> = {};
      if (typeof cfg.env === "object" && cfg.env !== null) {
        for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      out.push({
        name: srvName,
        command: cfg.command,
        args: Array.isArray(cfg.args)
          ? cfg.args.filter((a): a is string => typeof a === "string")
          : [],
        env,
        enabled: true,
      });
    }
    return out;
  };

  const doImport = async () => {
    const imported = parseImportText(importText);
    if (!imported || imported.length === 0) {
      setImportMsg({ ok: false, text: t("mcp.importFail") });
      return;
    }
    // Merge по имени: существующие обновляются (enabled сохраняется), новые добавляются
    const byName = new Map(serversRef.current.map((s) => [s.name, s]));
    for (const s of imported) {
      const existing = byName.get(s.name);
      byName.set(s.name, existing ? { ...s, enabled: existing.enabled } : s);
    }
    const next = [...byName.values()];
    await persist(next);
    setImportMsg({ ok: true, text: t("mcp.importOk", { n: imported.length }) });
    setImportText("");
  };

  // Загрузка конфига и статусов при открытии вкладки
  useEffect(() => {
    mcpListServers()
      .then((list) => {
        serversRef.current = list;
        setServers(list);
      })
      .catch(() => {});
    mcpStatus()
      .then(setStatuses)
      .catch(() => {});
  }, []);

  const statusOf = (name: string): McpServerStatus | undefined =>
    statuses.find((s) => s.name === name);

  const refreshStatuses = () => {
    mcpStatus()
      .then(setStatuses)
      .catch(() => {});
  };

  /** Сохранить конфиг и синхронизировать набор схем инструментов */
  const persist = async (next: McpServerCfg[]) => {
    serversRef.current = next;
    setServers(next);
    try {
      await mcpSaveServers(next);
      invalidateToolSchemas();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const addServer = async () => {
    const n = name.trim();
    if (!n) return;
    if (remote) {
      const u = url.trim();
      if (!u) return;
      await persist([
        ...serversRef.current,
        {
          name: n,
          command: "",
          args: [],
          env: {},
          enabled: true,
          transport: "http",
          url: u,
          headers: parseHeaders(headers),
        },
      ]);
      setName("");
      setUrl("");
      setHeaders("");
      return;
    }
    const cmd = command.trim();
    if (!cmd) return;
    const argList = args
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    await persist([
      ...serversRef.current,
      { name: n, command: cmd, args: argList, env: {}, enabled: true },
    ]);
    setName("");
    setCommand("");
    setArgs("");
  };

  /** Текстовые заголовки "Name: value" построчно → карта (для remote MCP) */
  const parseHeaders = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const lineRaw of raw.split("\n")) {
      const line = lineRaw.trim();
      if (!line) continue;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  };

  const toggleEnabled = async (idx: number) => {
    const next = serversRef.current.map((s, i) =>
      i === idx ? { ...s, enabled: !s.enabled } : s,
    );
    await persist(next);
    // Выключили включённый сервер — отключаем соединение
    const srv = servers[idx];
    if (!srv) return;
    if (srv.enabled && statusOf(srv.name)?.connected) {
      await mcpDisconnect(srv.name).catch(() => {});
      refreshStatuses();
    }
  };

  const removeServer = async (idx: number) => {
    const srv = servers[idx];
    if (!srv) return;
    if (statusOf(srv.name)?.connected) {
      setBusy(srv.name);
      await mcpDisconnect(srv.name).catch(() => {});
      setBusy(null);
      refreshStatuses();
    }
    await persist(serversRef.current.filter((_, i) => i !== idx));
  };

  const connect = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await mcpConnect(name);
      refreshStatuses();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (name: string) => {
    setBusy(name);
    await mcpDisconnect(name).catch(() => {});
    setBusy(null);
    refreshStatuses();
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.mcp")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("mcp.desc")}
      </p>

      <div className="space-y-2">
        {servers.length === 0 && (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-xs leading-relaxed text-halo-muted">
            {t("mcp.empty")}
          </p>
        )}
        {servers.map((s, i) => {
          const st = statusOf(s.name);
          const connected = st?.connected ?? false;
          return (
            <div
              key={s.name}
              className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                {/* Статус-точка */}
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    connected
                      ? "bg-emerald-400"
                      : s.enabled
                        ? "bg-amber-400/70"
                        : "bg-halo-muted/40"
                  }`}
                  title={
                    connected
                      ? t("mcp.connected")
                      : s.enabled
                        ? t("mcp.disconnected")
                        : t("mcp.off")
                  }
                />
                <span className="min-w-0 truncate text-sm font-medium text-halo-text">
                  {s.name}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-halo-muted">
                  {s.transport ? `${s.transport} · ${s.url ?? ""}` : `${s.command} ${s.args.join(" ")}`}
                </code>
                <button
                  onClick={() => void toggleEnabled(i)}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    s.enabled
                      ? "border-emerald-400/40 text-emerald-400"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {s.enabled ? t("mcp.enabled") : t("mcp.off")}
                </button>
                {connected ? (
                  <button
                    onClick={() => void disconnect(s.name)}
                    disabled={busy === s.name}
                    className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-40"
                  >
                    {t("mcp.disconnect")}
                  </button>
                ) : (
                  <button
                    onClick={() => void connect(s.name)}
                    disabled={busy === s.name || !s.enabled}
                    className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === s.name ? "…" : t("mcp.connect")}
                  </button>
                )}
                <button
                  onClick={() => void removeServer(i)}
                  title={t("mcp.delete")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
              {/* Обнаруженные инструменты */}
              {st && st.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 pl-4">
                  {st.tools.map((tool) => (
                    <span
                      key={tool.name}
                      title={tool.description}
                      className="rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[10px] text-halo-muted"
                    >
                      mcp__{s.name}__{tool.name}
                    </span>
                  ))}
                  <span className="px-1 text-[10px] text-halo-muted/60">
                    {st.tools.length} {t("mcp.tools")}
                  </span>
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
      <div className="mt-4 space-y-2 rounded-xl border border-halo-line p-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.name")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        {/* Транспорт: локальный процесс или удалённый HTTP-сервер */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-halo-muted">{t("mcp.transport")}:</span>
          {(
            [
              ["stdio", t("mcp.transportStdio")],
              ["http", t("mcp.transportHttp")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setRemote(id === "http")}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                remote === (id === "http")
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {remote ? (
          <>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("mcp.url")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={t("mcp.headers")}
              rows={2}
              className="w-full resize-y rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <p className="text-[11px] leading-relaxed text-halo-muted/70">{t("mcp.headersHint")}</p>
          </>
        ) : (
          <>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("mcp.command")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t("mcp.args")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </>
        )}
        <div className="flex justify-end">
          <button
            onClick={() => void addServer()}
            disabled={
              !name.trim() ||
              (remote ? !url.trim() : !command.trim())
            }
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("mcp.add")}
          </button>
        </div>
      </div>

      {/* Импорт конфига в формате Claude Desktop / ZCode */}
      <div className="mt-3 rounded-xl border border-halo-line p-3">
        <button
          onClick={() => setImportOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 text-xs font-medium text-halo-muted transition-colors hover:text-halo-text"
        >
          <span className={`transition-transform ${importOpen ? "rotate-90" : ""}`}>›</span>
          {t("mcp.import")}
        </button>
        {importOpen && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] leading-relaxed text-halo-muted">
              {t("mcp.importHint")}
            </p>
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportMsg(null);
              }}
              rows={5}
              placeholder={t("mcp.importPh")}
              className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/50 focus:border-halo-accent/60"
            />
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[11px] ${importMsg?.ok ? "text-emerald-400" : "text-red-400"}`}
              >
                {importMsg?.text}
              </span>
              <button
                onClick={() => void doImport()}
                disabled={!importText.trim()}
                className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("mcp.importBtn")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Стилизованный дропдаун: нативный <select> рисует системный попап,
    который выбивается из тёмной темы — здесь свой список на div-ах */
