// Parses SGR mouse-wheel escape sequences directly off stdin (ink's own
// input handling is keyboard-only; it has no concept of mouse events),
// and calls onUp/onDown -- wired to the same scroll actions as the
// arrow keys. Requires fullscreen.ts's mouse reporting to be enabled.
// SGR mouse sequences look like "\x1b[<Cb;Cx;CyM" -- Cb 64 is wheel up,
// 65 is wheel down (ignoring modifier bits, good enough for scrolling).
import { useEffect } from "react";

const WHEEL_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

export function useMouseWheel(onUp: () => void, onDown: () => void): void {
  useEffect(() => {
    const stdin = process.stdin;
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text.includes("\x1b[<")) return;
      for (const match of text.matchAll(WHEEL_RE)) {
        const cb = Number(match[1]);
        if (cb === 64) onUp();
        else if (cb === 65) onDown();
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [onUp, onDown]);
}
