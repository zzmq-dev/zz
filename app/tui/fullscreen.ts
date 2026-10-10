// Puts the terminal into its alternate screen buffer for the life of
// the process, the way a real full-screen app (less, vim, Textual's own
// apps) does -- so the TUI occupies a stable viewport instead of
// printing into (and growing) the shell's normal scrollback. Restores
// the original screen on any exit path so the shell is left clean.
//
// Also enables mouse reporting (click + wheel, SGR encoding) so the
// scroll wheel can drive the same scroll actions as the arrow keys (see
// useMouseWheel.ts) -- the one real tradeoff this introduces is that a
// plain click-drag no longer starts the terminal's own text selection,
// since button presses now go to the app instead. Hold Option (macOS)
// or Shift (most other terminals) while clicking/dragging to force the
// terminal to select text natively anyway -- a standard convention, not
// a workaround specific to this app.
let active = false;

export function enterFullscreen(): void {
  if (active) return;
  active = true;
  process.stdout.write("\x1B[?1049h"); // switch to alternate screen buffer
  process.stdout.write("\x1B[2J\x1B[H"); // clear it, cursor to home
  process.stdout.write("\x1B[?25l"); // hide cursor
  process.stdout.write("\x1B[?1000h"); // enable mouse reporting (click + wheel)
  process.stdout.write("\x1B[?1006h"); // SGR extended mouse encoding
  const restore = () => exitFullscreen();
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(0);
  });
}

export function exitFullscreen(): void {
  if (!active) return;
  active = false;
  process.stdout.write("\x1B[?1006l");
  process.stdout.write("\x1B[?1000l");
  process.stdout.write("\x1B[?25h"); // show cursor
  process.stdout.write("\x1B[?1049l"); // restore the normal screen buffer
}
