/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#0f172a",
    "accent": "#1d4ed8",
    "border": "#d9e0ea",
    "danger": "#b42318",
    "success": "#15803d",
    "surface": "#f5f7fb",
    "textMuted": "#4b5567",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeff7",
    "borderStrong": "#b8c3d3"
  },
  "shape": {
    "radius": 6
  }
};
