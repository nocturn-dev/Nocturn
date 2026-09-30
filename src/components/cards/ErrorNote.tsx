import { useLang } from "../../locales";
import { ChevronDownIcon } from "./icons";
import { useState } from "react";

export function ErrorNote({ title, raw }: { title: string; raw: string }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 w-full rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="shrink-0 text-amber-400">⚠</span>
        <span className="flex-1 text-xs leading-relaxed text-halo-text">
          {title}
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text`}
        >
          {t("err.details")}
          <ChevronDownIcon className={open ? "" : "-rotate-90"} />
        </span>
      </button>
      {open && (
        <pre className="scroll-slim mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-red-400/20 pt-2 font-mono text-[0.625rem] leading-relaxed text-halo-muted">
          {raw}
        </pre>
      )}
    </div>
  );
}

/** Виджет Progress: план задач агента в левом верхнем углу чата.
    Наполняется инструментом plan_update (исполнение — на фронтенде в App):
    строки с иконкой статуса и счётчик done/total в заголовке */