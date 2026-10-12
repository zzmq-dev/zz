// Shared color tokens for the TUI: a muted purple backdrop (chrome --
// borders, header bar, de-emphasized text) with saturated, "pick one
// thing to pop" accents for anything that's actually signal (an active
// tab, a Lane's status, a live event kind) -- the look several
// top-tier terminal dashboards (k9s, lazygit, bottom) share: a dark,
// low-saturation base so a handful of neon colors used sparingly stay
// legible instead of competing with each other.
export const BACKDROP = "#241433";
export const PANEL = "#2D1B4E";
export const BORDER = "#7B5EA7";
export const MUTED = "#9D8CB8";

export const PINK = "#FF2E92";
export const YELLOW = "#E8FF3D";
export const CYAN = "#2EE6FF";
export const GREEN = "#4CFF6E";
export const BLUE = "#5C8DFF";
export const RED = "#FF4466";

export const STATUS_COLOR: Record<string, string> = {
  proposed: YELLOW,
  open: YELLOW,
  claimed: BLUE,
  active: CYAN,
  merged: GREEN,
  closed: MUTED,
  vetoed: RED,
  stopped: RED,
};
