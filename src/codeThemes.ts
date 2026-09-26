import githubDark from "highlight.js/styles/github-dark.min.css?inline";
import atomOneDark from "highlight.js/styles/atom-one-dark.min.css?inline";
import nord from "highlight.js/styles/nord.min.css?inline";
import githubLight from "highlight.js/styles/github.min.css?inline";

/**
 * Палитры подсветки кода (кастомизация): полные темы highlight.js,
 * инжектируются <style id="halo-hljs-theme"> поверх статического
 * github-dark из main.tsx (дефолт «midnight» = он же). Фон код-блока
 *(theme-фоны) гасится: bg управляется --halo-code-bg/-text.
 */
export const CODE_THEMES: Record<string, { label: string; css: string }> = {
  midnight: { label: "Midnight", css: githubDark },
  "one-dark": { label: "One Dark", css: atomOneDark },
  nord: { label: "Nord", css: nord },
  light: { label: "GitHub Light", css: githubLight },
};

export const CODE_THEME_IDS = Object.keys(CODE_THEMES);

/** Применить палитру подсветки (идемпотентно) */
export function applyCodeTheme(id: string): void {
  const theme = CODE_THEMES[id] ?? CODE_THEMES.midnight;
  if (!theme) return;
  let el = document.getElementById("halo-hljs-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "halo-hljs-theme";
    document.head.appendChild(el);
  }
  el.textContent = `${theme.css}\n.markdown pre code.hljs, pre code.hljs { background: transparent !important; }`;
}
