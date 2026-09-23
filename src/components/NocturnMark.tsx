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
  const uid = useId();
  const boldId = `mark-bold-${uid}`;
  const classicId = `mark-classic-${uid}`;
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
        <linearGradient id={boldId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#38C7EE" />
          <stop offset="1" stopColor="#254EE1" />
        </linearGradient>
        <linearGradient id={classicId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#38C7EE" />
          <stop offset="1" stopColor="#254EE1" />
        </linearGradient>
        {/* Маска порезов: чёрные полосы вырезают штрих насквозь */}
        <mask id={`${boldId}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <path d={cutLine(5.8, 7.6)} stroke="black" strokeWidth="1.8" />
          <path d={cutLine(18.2, 16.2)} stroke="black" strokeWidth="1.8" />
        </mask>
      </defs>

      {/* Новый знак: широкая N с порезами */}
      <g className="mark-bold">
        <path
          d="M4.2 20.2 L7.6 3.8 L16.4 20.2 L19.8 3.8"
          stroke={`url(#${boldId})`}
          strokeWidth="2.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          mask={`url(#${boldId}-mask)`}
        />
      </g>

      {/* Классический знак: тонкая N */}
      <g className="mark-classic">
        <path
          d="M5.4 19.8 L8.7 4.4 L15.3 19.6 L18.6 4.2"
          stroke={`url(#${classicId})`}
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
