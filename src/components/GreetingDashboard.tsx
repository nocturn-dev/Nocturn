/**
 * Живое состояние локального окружения на пустом экране чата. Унификация
 * 01.10 по практике ChatGPT/Claude (пустой экран = приветствие + композер,
 * никаких списков задач и чипов-промтов): остались только два компактных
 * интерактивных индикатора — это и есть «help cue» по NN/g:
 *  - MCP: число подключённых серверов (клик → настройки MCP);
 *  - Colibri: локальный MoE-движок запущен/нет (клик → настройки).
 * Данные — локальные invoke'ы, один снимок на монтирование; ноль сети.
 */

import { useEffect, useState } from "react";
import { colibriStatus, mcpStatus } from "../api";
import { useLang } from "../locales";

export interface GreetingDashboardProps {
  onOpenSettingsSection?: (section: "mcp" | "main") => void;
}

interface StatusCards {
  mcpConnected: number | null;
  colibriRunning: boolean | null;
}

export default function GreetingDashboard({
  onOpenSettingsSection,
}: GreetingDashboardProps) {
  const { t } = useLang();
  const [status, setStatus] = useState<StatusCards>({
    mcpConnected: null,
    colibriRunning: null,
  });

  useEffect(() => {
    let disposed = false;
    void mcpStatus()
      .then((list) => {
        if (!disposed) {
          setStatus((prev) => ({ ...prev, mcpConnected: list.length }));
        }
      })
      .catch(() => {});
    void colibriStatus()
      .then((st) => {
        if (!disposed) {
          setStatus((prev) => ({ ...prev, colibriRunning: st.running }));
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const card =
    "flex min-w-36 items-center gap-2 rounded-xl border border-halo-line bg-halo-surface/50 px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-halo-accent/40 hover:bg-halo-surface";

  return (
    <div className="flex flex-wrap justify-center gap-2">
      <button
        onClick={() => onOpenSettingsSection?.("mcp")}
        className={card}
        title={t("greet.mcpHint")}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            status.mcpConnected === null
              ? "bg-halo-muted/50"
              : status.mcpConnected > 0
                ? "bg-emerald-400"
                : "bg-halo-muted/50"
          }`}
        />
        <span className="text-xs text-halo-muted">
          {status.mcpConnected === null
            ? t("greet.mcp")
            : status.mcpConnected > 0
              ? t("greet.mcpCount", { n: String(status.mcpConnected) })
              : t("greet.mcpNone")}
        </span>
      </button>
      <button
        onClick={() => onOpenSettingsSection?.("main")}
        className={card}
        title={t("greet.colibriHint")}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            status.colibriRunning === null
              ? "bg-halo-muted/50"
              : status.colibriRunning
                ? "bg-emerald-400"
                : "bg-halo-muted/50"
          }`}
        />
        <span className="text-xs text-halo-muted">
          {status.colibriRunning === null
            ? t("greet.colibri")
            : status.colibriRunning
              ? t("greet.colibriOn")
              : t("greet.colibriOff")}
        </span>
      </button>
    </div>
  );
}
