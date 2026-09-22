/**
 * Логотип Nocturn: курсивная «N» с градиентом циан → синий —
 * тот же знак, что и в иконке приложения. Используется в сайдбаре,
 * на экране приветствия и как призрак на фоне чата.
 */
export default function NocturnMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="nocturn-n-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#38C7EE" />
          <stop offset="1" stopColor="#254EE1" />
        </linearGradient>
      </defs>
      {/* Курсивная N: размашистая — широкие ноги и диагональ */}
      <path
        d="M5.4 19.8 L8.7 4.4 L15.3 19.6 L18.6 4.2"
        stroke="url(#nocturn-n-grad)"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
