export const THEME_STORAGE_KEY = "composer-api-theme";
export const DEFAULT_THEME = "station";

export const THEMES = [
  {
    id: "station",
    label: "登陆站",
    blurb: "海缆机房：冰蓝信号、铜护套。",
    scheme: "dark",
    swatches: ["#06131a", "#5ce1ff", "#e09a4a"]
  },
  {
    id: "ember",
    label: "铜灯",
    blurb: "夜班钨丝灯，护套铜皮发亮。",
    scheme: "dark",
    swatches: ["#140c08", "#e8a44a", "#ff7a5c"]
  },
  {
    id: "phosphor",
    label: "磷光",
    blurb: "机柜里的绿磷 CRT。",
    scheme: "dark",
    swatches: ["#06140c", "#3ee08a", "#c8e05a"]
  },
  {
    id: "iris",
    label: "鸢尾",
    blurb: "深夜实验室，紫外指示灯。",
    scheme: "dark",
    swatches: ["#0c0a18", "#a78bfa", "#5ce1ff"]
  },
  {
    id: "daylight",
    label: "白昼",
    blurb: "白天操作台，冷白底、深青强调。",
    scheme: "light",
    swatches: ["#e8eef1", "#0b7a90", "#b86a1c"]
  },
  {
    id: "obsidian",
    label: "值守",
    blurb: "事故台：近黑底、故障红。",
    scheme: "dark",
    swatches: ["#080808", "#ff6b7d", "#e09a4a"]
  }
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export function parseThemeId(value: string | null | undefined): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? (value as ThemeId) : DEFAULT_THEME;
}

export function themeById(id: ThemeId): (typeof THEMES)[number] {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function readStoredTheme(): ThemeId {
  try {
    return parseThemeId(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId): void {
  const theme = themeById(id);
  document.documentElement.setAttribute("data-theme", theme.id);
  document.documentElement.style.colorScheme = theme.scheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme.swatches[0]);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    /* private mode */
  }
}

export function initTheme(): void {
  applyTheme(readStoredTheme());
}
