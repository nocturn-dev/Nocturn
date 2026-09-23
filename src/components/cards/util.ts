

export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  const v = (n / 1000).toFixed(1).replace(".", ",");
  return `${v.replace(",0", "")}k`;
}
