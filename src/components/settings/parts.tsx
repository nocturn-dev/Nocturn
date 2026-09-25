import { useEffect, useRef, useState } from "react";
import { useLangState, useLangSetter } from "../../locales";
import type { Appearance } from "../../appearance";

export function StylePattern({ id }: { id: Appearance["style"] }) {
  const P = ({
    children,
    vb = "0 0 32 32",
  }: {
    children: React.ReactNode;
    vb?: string;
  }) => (
    <svg width="1em" height="1em" viewBox={vb} fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
  switch (id) {
    case "forest":
      // Ель + малая ель + поляна
      return (
        <P>
          <path d="M10 26 L15 12 L20 26 Z M15 12 L12.4 17 H17.6 Z" />
          <path d="M15 8 L12.8 13 H17.2 Z" opacity="0.8" />
          <path d="M22 26 L25 17 L28 26 Z" opacity="0.7" />
          <ellipse cx="17" cy="27.5" rx="11" ry="1.6" opacity="0.5" />
        </P>
      );
    case "storm":
      // Облако + молния
      return (
        <P>
          <path d="M9 12a6 6 0 0 1 11.5-2A5 5 0 0 1 21 19.8H10A4.5 4.5 0 0 1 9 12z" />
          <path d="M17 17 L11.5 25 H15 L13.5 31 L20 22.5 H16.4 L18.5 17 Z" />
        </P>
      );
    case "midnight":
      // Полумесяц + звёзды
      return (
        <P>
          <path d="M20 4a11 11 0 1 0 7 19.5A12.5 12.5 0 0 1 20 4z" />
          <path d="M8 8l1 2.4L11.4 11.4 9 12.4 8 14.8 7 12.4 4.6 11.4 7 10.4z" opacity="0.9" />
          <circle cx="12" cy="20" r="1.1" opacity="0.7" />
        </P>
      );
    case "abyss":
      // Волны + пузырь
      return (
        <P>
          <path d="M0 18c3-3 6-3 9 0s6 3 9 0 6-3 9 0 5 2.6 5 2.6V32H0z" opacity="0.9" />
          <path d="M0 25c3-2.6 6-2.6 9 0s6 2.6 9 0 6-2.6 9 0 5 2.2 5 2.2V32H0z" opacity="0.6" />
          <circle cx="8" cy="9" r="2" opacity="0.7" />
          <circle cx="14" cy="5" r="1.2" opacity="0.5" />
        </P>
      );
    case "dusk":
      // Горы + серп
      return (
        <P>
          <path d="M2 27 L12 12 L19 23 L23 18 L30 27 Z" opacity="0.85" />
          <path d="M23 4a8 8 0 1 0 5 14A9.4 9.4 0 0 1 23 4z" opacity="0.9" />
        </P>
      );
    case "sepia":
      // Лист с прожилкой
      return (
        <P>
          <path d="M16 3C8 9 6 17 8 24c7 2 15 0 19-8C23 9 20 5 16 3z" />
          <path d="M16 3C14 12 12 19 9 27" stroke="var(--halo-bg)" strokeWidth="1.6" fill="none" />
        </P>
      );
    case "rosewood":
      // Роза: спираль + лист
      return (
        <P>
          <circle cx="14" cy="12" r="9" opacity="0.25" />
          <path d="M14 12a4 4 0 1 1 4 4 6 6 0 1 1-8-1 8.5 8.5 0 0 1 11-1" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M17 22c3 1 5 4 5 8-4 0-7-2-8-5z" opacity="0.8" />
        </P>
      );
    default:
      // Claude — солнце с лучами
      return (
        <P>
          <circle cx="16" cy="16" r="6" />
          <g opacity="0.85">
            <path d="M16 2v5 M16 25v5 M2 16h5 M25 16h5 M6 6l3.5 3.5 M22.5 22.5L26 26 M26 6l-3.5 3.5 M9.5 22.5L6 26" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          </g>
        </P>
      );
  }
}

/** Иконки разделов (14px, stroke — под цвет текста) */
export function SectionIcon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0",
  };
  const paths: Record<string, string> = {
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    palette: "M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-2 2c0 1 .5 1.5.5 2.5S13 21 12 21z M7.5 10.5h.01 M12 7h.01 M16.5 10.5h.01",
    box: "M21 8l-9-5-9 5v8l9 5 9-5V8z M3 8l9 5 9-5 M12 13v8",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z",
    monitor: "M8 21h8 M12 17v4 M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    keyboard: "M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10",
    spark: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.2 2.2 M16.2 16.2l2.2 2.2 M18.4 5.6l-2.2 2.2 M7.8 16.2l-2.2 2.2",
    brain: "M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1v3 M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1v3 M9 3h6",
    users: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M21 21v-2a4 4 0 0 0-3-3.9 M15 3.1a4 4 0 0 1 0 7.8",
    grid: "M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z",
    plug: "M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0V8z M12 18v4",
    skill: "M12 2l2.4 5.9L20 10l-5.6 2.1L12 18l-2.4-5.9L4 10l5.6-2.1L12 2z",
    terminal: "M4 17l6-5-6-5 M12 19h8",
    command: "M15 6a3 3 0 1 1 3 3h-3zM9 6a3 3 0 1 0-3 3h3zM15 18a3 3 0 1 0 3-3h-3zM9 18a3 3 0 1 1-3-3h3zM9 9h6v6H9z",
    anchor: "M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 8v13 M5 12a7 7 0 0 0 14 0 M3 12h4 M17 12h4",
    chart: "M3 21h18 M7 21V9 M12 21V3 M17 21v-8",
    image: "M3 5h18v14H3z M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z",
  };
  return <svg {...common}><path d={paths[name] ?? paths.gear} /></svg>;
}


export function Dropdown({
  value,
  options,
  onSelect,
  className = "",
}: {
  value: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Гасим событие, чтобы оно не дошло до window-обработчика модалки
        // и не закрыло всё окно настроек
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  const [hoverIdx, setHoverIdx] = useState(-1);
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // D12: клавиатурная навигация — раньше выбрать опцию можно было
          // только мышью (дропдауны живут в темах, хуках и хоткеях)
          if (!open) {
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
              setHoverIdx(Math.max(0, options.findIndex((o) => o.value === value)));
            }
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHoverIdx((i) => Math.min(options.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHoverIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && hoverIdx >= 0) {
            e.preventDefault();
            const o = options[hoverIdx];
            if (o) {
              onSelect(o.value);
              setOpen(false);
            }
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-left text-xs text-halo-text outline-none transition-colors hover:border-halo-muted/50"
      >
        <span className="min-w-0 truncate">{current?.label ?? ""}</span>
        <span className={`shrink-0 text-[10px] text-halo-muted transition-transform ${open ? "rotate-180" : ""}`}>
          ▼
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          className="anim-pop absolute right-0 z-30 mt-1 max-h-64 min-w-full overflow-y-auto rounded-lg border border-halo-line bg-halo-deep py-1 shadow-xl scroll-slim"
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => {
                onSelect(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ${
                o.value === value || i === hoverIdx
                  ? "bg-halo-hover text-halo-text"
                  : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
              }`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && (
                <span className="shrink-0 text-halo-accent">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Раздел «Горячие клавиши»: перебиндивание действий + свои хоткеи на slash-команды */

export function LangSwitch() {
  const lang = useLangState();
  const setLang = useLangSetter();
  const langs = [
    { id: "ru", label: "Русский" },
    { id: "en", label: "English" },
    { id: "zh", label: "中文" },
    { id: "ja", label: "日本語" },
  ] as const;
  return (
    <div className="flex flex-wrap rounded-lg border border-halo-line p-0.5">
      {langs.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => setLang(id)}
          className={`rounded-md px-2 py-1 text-xs transition-all duration-150 ${
            lang === id
              ? "bg-halo-accent/15 font-medium text-halo-accent"
              : "text-halo-muted hover:text-halo-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Row({ 
  label,
  desc,
  value,
  extra,
}: {
  label: string;
  desc?: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-2.5 text-sm">
      <span className="min-w-0">
        <span className="text-halo-text">{label}</span>
        {desc && (
          <span className="mt-0.5 block text-xs leading-relaxed text-halo-muted">
            {desc}
          </span>
        )}
      </span>
      {extra ?? <span className="text-halo-muted">{value}</span>}
    </div>
  );
}

export function ToggleRow({
  label,
  desc,
  disabled,
  defaultOn,
  on,
  onChange,
}: {
  label: string;
  /** Пояснение под названием строки (мелким приглушённым шрифтом) */
  desc?: string;
  disabled?: boolean;
  defaultOn?: boolean;
  /** Контролируемый режим: значение извне */
  on?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const [inner, setInner] = useState(!!defaultOn);
  const value = on ?? inner;
  const toggle = () => {
    if (disabled) return;
    if (onChange) onChange(!value);
    else setInner((v) => !v);
  };
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-2.5 text-sm">
      <span className="min-w-0">
        <span className={disabled ? "text-halo-muted" : "text-halo-text"}>
          {label}
        </span>
        {desc && (
          <span className="mt-0.5 block text-xs leading-relaxed text-halo-muted">
            {desc}
          </span>
        )}
      </span>
      <button
        onClick={toggle}
        disabled={disabled}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          value ? "bg-halo-accent" : "bg-halo-line"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
            value ? "left-4.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** Раздел «Память»: долгосрочный контекст проектов */

export function MiniPencilIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.85 2.83 4 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

export function MiniTrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}


export function MiniCheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function MiniSearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Разворот окна настроек на весь экран */
export function ExpandWinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M8 21H5a2 2 0 0 1-2-2v-3 M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function CollapseWinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3 M16 3v3a2 2 0 0 0 2 2h3 M8 21v-3a2 2 0 0 0-2-2H3 M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
