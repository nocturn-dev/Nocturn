import { useId } from "react";

/**
 * Логотип Nocturn: курсивная «N» с градиентом циан → синий.
 * Два варианта знака, переключаются темой кастомизации (html[data-mark]):
 *  - bold (по умолчанию) — новый знак: широкая N с диагональными порезами,
 *    как на иконке приложения;
 *  - classic — прежняя тонкая N.
 * Вариант выбирается CSS (display), а не пропсами — компонент везде один.
 */
export default function NocturnMark({ size = 16 }: { size?: number }) {
  // useId в React даёт ":r0:" — двоеточие в url(#...) парсер ссылок SVG
  // на WebKitGTK не понимает, и градиент отваливается. Чистим до безопасного
  const uid = useId().replace(/:/g, "");
  const gradientId = `mark-grad-${uid}`;
  // Порезы: линии параллельны среднему штриху N, координаты — юниты 24×24
  const cutDir = { x: 0.472, y: 0.881 };
  const cutLine = (px: number, py: number) => {
    const x1 = px - cutDir.x * 13;
    const y1 = py - cutDir.y * 13;
    const x2 = px + cutDir.x * 13;
    const y2 = py + cutDir.y * 13;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="nocturn-mark"
    >
      <defs>
        {/* Цвет знака переопределяется кастомизацией (--halo-mark-from/-to,
            Кастомизация → Брендинг); пусто — градиент из акцента темы:
            фирменный циан→синий был зашит и конфликтовал с любой темой,
            кроме «синих» (знак оставался голубым на зелёном/розовом).
            var() живёт только в CSS-значении — stop-color презентационным
            атрибутом его не принимает, поэтому через style */}
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--halo-mark-from, var(--halo-accent))" }} />
          <stop offset="1" style={{ stopColor: "var(--halo-mark-to, var(--halo-accent-deep))" }} />
        </linearGradient>
        {/* Маска порезов: чёрные полосы вырезают штрих насквозь */}
        <mask id={`${gradientId}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <path d={cutLine(5.8, 7.6)} stroke="black" strokeWidth="1.8" />
          <path d={cutLine(18.2, 16.2)} stroke="black" strokeWidth="1.8" />
        </mask>
      </defs>

      {/* Новый знак: широкая N с порезами. Оба варианта ссылаются на один
          градиент — раньше их определения дублировались и разъезжались бы
          при первой правке цвета */}
      <g className="mark-bold">
        <path
          d="M4.2 20.2 L7.6 3.8 L16.4 20.2 L19.8 3.8"
          stroke={`url(#${gradientId})`}
          strokeWidth="2.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          mask={`url(#${gradientId}-mask)`}
        />
      </g>

      {/* Классический знак: тонкая N */}
      <g className="mark-classic">
        <path
          d="M5.4 19.8 L8.7 4.4 L15.3 19.6 L18.6 4.2"
          stroke={`url(#${gradientId})`}
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
