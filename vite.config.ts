import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Rust-компиляция пишет в target/ и блокирует файлы — Vite не должен их вотчить
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // safari16 — пол для WKWebView (macOS): esbuild не полифиллит, но
    // трансляция синтаксиса не будет опираться на более новый движок
    target: ["chrome120", "safari16"],
    minify: "esbuild",
    sourcemap: false,
  },
});
