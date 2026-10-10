// The actual terminal size, kept live across resizes -- what makes it
// possible to size content panes to the real screen instead of a guess,
// so a tab's content clips/truncates to what fits rather than spilling
// into the shell's own scrollback.
import { useEffect, useState } from "react";
import { useStdout } from "ink";

export function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const out = stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ rows: out.rows || 24, columns: out.columns || 80 });

  useEffect(() => {
    const onResize = () => setSize({ rows: out.rows || 24, columns: out.columns || 80 });
    out.on("resize", onResize);
    return () => {
      out.off("resize", onResize);
    };
  }, [out]);

  return size;
}
