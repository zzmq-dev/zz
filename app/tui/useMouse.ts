// Parses SGR mouse escape sequences directly off stdin (ink's own input
// handling is keyboard-only; it has no concept of mouse events) --
// wheel up/down (wired to scrolling) and a plain left-click press
// (wired to clicking a tab), with its terminal column/row so the
// caller can decide what, if anything, was clicked. Requires
// fullscreen.ts's mouse reporting to be enabled. SGR sequences look
// like "\x1b[<Cb;Cx;CyM" (press) or "...m" (release) -- Cb 64/65 are
// wheel up/down, Cb 0 is the left button.
import { useEffect, useRef } from "react";

const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export interface MouseHandlers {
  onWheelUp?: () => void;
  onWheelDown?: () => void;
  onClick?: (col: number, row: number) => void;
}

export function useMouse(handlers: MouseHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const stdin = process.stdin;
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text.includes("\x1b[<")) return;
      for (const match of text.matchAll(MOUSE_RE)) {
        const cb = Number(match[1]);
        const col = Number(match[2]);
        const row = Number(match[3]);
        const isPress = match[4] === "M";
        if (cb === 64) handlersRef.current.onWheelUp?.();
        else if (cb === 65) handlersRef.current.onWheelDown?.();
        else if (cb === 0 && isPress) handlersRef.current.onClick?.(col, row);
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, []);
}
