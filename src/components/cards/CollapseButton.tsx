import { useLang } from "../../locales";

export function CollapseButton({ onClick }: { onClick: () => void }) {
  const { t } = useLang();
  return (
    <button
      onClick={onClick}
      title={t("card.collapse")}
      className="absolute -top-2 right-2 flex size-5 items-center justify-center rounded-full border border-halo-line bg-halo-deep text-halo-muted opacity-0 shadow-sm transition-all duration-150 hover:text-halo-text group-hover:opacity-100"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M5 12h14" />
      </svg>
    </button>
  );
}

/** Боковая линейка: чёрточка на каждое сообщение, клик — прыжок к нему */