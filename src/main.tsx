import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickEntry } from "./QuickEntry";
import "./index.css";
import { LangProvider } from "./locales";
import { applyCodeTheme } from "./codeThemes";
import { applyAppearance, loadAppearance } from "./appearance";
import { applyUserCss, readUserCss } from "./userCss";

// S10: статический github-dark удалён — это дословный дубль темы «midnight»,
// собиравший одни и те же правила дважды. Подсветка инжектится до первого
// рендера, чтобы код-блоки первого экрана не мигали неоформленными
try {
  const raw = localStorage.getItem("haloui-appearance");
  const codeTheme = raw
    ? (JSON.parse(raw) as { codeTheme?: string }).codeTheme
    : undefined;
  applyCodeTheme(codeTheme ?? "midnight");
} catch {
  applyCodeTheme("midnight");
}

// Пользовательский CSS — до первого рендера (как и код-темы): из эффекта
// App он приезжал после первой отрисовки, community-темы давали FOUC
try {
  applyUserCss(readUserCss());
} catch {
  // битый userCss не должен ронять старт
}

// Приложение должно ощущаться нативным: системное меню браузера не нужно,
// оставляем его только для полей ввода (копирование/вставка)
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
    e.preventDefault();
  }
});

// D3: componentDidCatch не ловит async-ошибки (промисы IPC/стрима) —
// глобальный хук хотя бы логирует их вместо полной тишины
window.addEventListener("unhandledrejection", (e) => {
  console.error("[nocturn] unhandled promise rejection:", e.reason);
});

// Quick Entry — второе окно (index.html?window=quickentry): тот же бандл,
// вместо полного App рендерится поле быстрого ввода
const isQuickEntry =
  new URLSearchParams(window.location.search).get("window") === "quickentry";

// Кастомизацию главного окна применяет App, у второго окна его нет —
// подтягиваем сохранённую тему/акцент/шрифты до первого рендера
if (isQuickEntry) {
  try {
    const a = loadAppearance();
    applyAppearance(a);
    document.documentElement.classList.toggle(
      "light",
      localStorage.getItem("haloui-theme") === "light" && !a.official,
    );
  } catch {
    // нет сохранённой кастомизации — дефолтная палитра из index.css
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LangProvider>{isQuickEntry ? <QuickEntry /> : <App />}</LangProvider>
  </React.StrictMode>,
);

// Прогрев аудиотракта (только главное окно): ПЕРВЫЙ getUserMedia в сессии
// WebView2 синхронно инициализирует аудиостек ОС и морозил UI на несколько
// секунд — проявлялось как разовое зависание на первом нажатии диктовки
// (выбор микрофона в настройках лечил, потому что грел тем же запросом).
// Тихо открываем и сразу освобождаем устройство при старте: к реальной
// записи тракт уже горячий. Если разрешение ещё не выдано — промис тихо
// отклонится, ничего не всплывёт
if (!isQuickEntry) {
  window.setTimeout(() => {
    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => {});
  }, 2500);
}
