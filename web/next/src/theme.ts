import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const subs = new Set<() => void>();
export const getTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("postmoney:theme", t); } catch { /* the choice lasts for this page only */ }
  subs.forEach((f) => f());
}
export const useTheme = (): Theme => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getTheme);
