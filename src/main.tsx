import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { LangProvider } from "./locales";
import "highlight.js/styles/github-dark.min.css";

// Приложение должно ощущаться нативным: системное меню браузера не нужно,
// оставляем его только для полей ввода (копирование/вставка)
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>,
);
