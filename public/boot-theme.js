/**
 * Ранняя тема фона окна: классический скрипт в <head> исполняется ДО первой
 * отрисовки (module-скрипты — deferred, они бы опоздали), а инлайн-скрипт
 * невозможен — CSP режет его в script-src 'self'. Поэтому внешний файл.
 *
 * Условие «светлая» повторяет main.tsx (QuickEntry-ветку): haloui-theme=light
 * И ни одна жёсткая тема (official/fullClaude — всегда тёмные). Цвет — deep
 * базовой палитры claude: значение #1f1e1d продублировано здесь и в
 * index.html осознанно (анти-FOUC, до бандла не доехать); TS-сторона берёт
 * его из STYLE_PALETTES.claude.dark.deep (Splash/QuickEntry), своих
 * литералов там больше нет.
 */
(function () {
  try {
    var appearance = {};
    try {
      appearance =
        JSON.parse(localStorage.getItem("haloui-appearance") || "{}") || {};
    } catch (e) {
      /* битый JSON — считаем дефолт (тёмная) */
    }
    var light =
      localStorage.getItem("haloui-theme") === "light" &&
      !appearance.official &&
      !appearance.fullClaude;
    var bg = light ? "#faf9f5" : "#1f1e1d";
    document.documentElement.style.background = bg;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", bg);
  } catch (e) {
    /* нет localStorage — остаётся фон из <style> в index.html */
  }
})();
