import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, parseThemeId, themeById } from "./theme";

describe("theme ids", () => {
  it("accepts known palettes and falls back otherwise", () => {
    expect(parseThemeId("station")).toBe("station");
    expect(parseThemeId("daylight")).toBe("daylight");
    expect(parseThemeId("nope")).toBe(DEFAULT_THEME);
    expect(parseThemeId(null)).toBe(DEFAULT_THEME);
  });

  it("resolves swatches for the browser chrome color", () => {
    expect(themeById("station").swatches[0]).toBe("#06131a");
    expect(themeById("daylight").scheme).toBe("light");
  });
});
