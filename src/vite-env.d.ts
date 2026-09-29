/// <reference types="vite/client" />

declare module "*?inline" {
  const css: string;
  export default css;
}

// Voice Wake: флаг занятости микрофона (диктовка ChatArea ↔ слушатель wake)
interface Window {
  __nocturnMicBusy?: boolean;
}
