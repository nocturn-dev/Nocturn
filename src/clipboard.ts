/**
 * Копирование в буфер обмена. Основной путь — Rust-команда clipboard_write
 * (arboard): нативная запись не проходит через navigator.clipboard, который
 * является перехватываемой поверхностью (клиппер-малварь подменяет текст).
 * Фолбэки — для браузерного превью вне Tauri: navigator.clipboard в WebKitGTK
 * полноценно появился поздно (2.36+), а vite target держит старые движки;
 * execCommand устарел, но как последний фолбэк работает везде.
 */

import { clipboardWrite } from "./api";

/** Скопировать текст; true — успех (любым из путей) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await clipboardWrite(text);
    return true;
  } catch {
    // нет Tauri (браузерное превью) или команда упала — JS-пути ниже
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API недоступен/запрещён — ручной путь через скрытую textarea
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Вне вьюпорта, но не display:none — иначе фокус/выделение не сработают
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
