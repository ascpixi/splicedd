import { cfg } from "../config";

export function refreshDarkMode() {
  if (cfg().darkMode) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}