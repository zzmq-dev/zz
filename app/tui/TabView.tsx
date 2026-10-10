// A real full-screen tabbed frame: fixed to the terminal's actual size
// (see useTerminalSize) with a bordered content pane sized to fit, so
// nothing spills into scrollback. Left/right arrows (or h/l) switch
// tabs; up/down arrows (or k/j), Page Up/Down, and Home/End scroll the
// active tab's content -- each content renderer decides what a given
// scroll offset actually means (older entries for a log, earlier rows
// for a list) since that differs per view. q or Ctrl+C quits (restoring
// the normal screen first).
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { useTerminalSize } from "./useTerminalSize.js";
import { exitFullscreen } from "./fullscreen.js";

export interface Tab {
  label: string;
  /** Given how many rows are available and the current scroll offset (0 = latest/top), render this tab's content sized to fit. */
  content: (maxRows: number, scrollOffset: number) => React.ReactNode;
}

const CHROME_ROWS = 5; // title/tab bar (1) + blank (1) + content box border (2) + footer (1)

export function TabView({ title, tabs }: { title: string; tabs: Tab[] }) {
  const [active, setActive] = useState(0);
  const [scroll, setScroll] = useState(0);
  const { isRawModeSupported } = useStdin();
  const { rows, columns } = useTerminalSize();
  const contentHeight = Math.max(3, rows - CHROME_ROWS);
  const pageSize = Math.max(1, contentHeight - 2);

  useEffect(() => setScroll(0), [active]);

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        exitFullscreen();
        process.exit(0);
      }
      if (key.rightArrow || input === "l") setActive((i) => (i + 1) % tabs.length);
      else if (key.leftArrow || input === "h") setActive((i) => (i - 1 + tabs.length) % tabs.length);
      else if (key.upArrow || input === "k") setScroll((s) => s + 1);
      else if (key.downArrow || input === "j") setScroll((s) => Math.max(0, s - 1));
      else if (key.pageUp) setScroll((s) => s + pageSize);
      else if (key.pageDown) setScroll((s) => Math.max(0, s - pageSize));
      else if (key.home) setScroll(Number.MAX_SAFE_INTEGER);
      else if (key.end) setScroll(0);
      else {
        const n = Number(input);
        if (Number.isInteger(n) && n >= 1 && n <= tabs.length) setActive(n - 1);
      }
    },
    { isActive: isRawModeSupported },
  );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{"  "}</Text>
        {tabs.map((t, i) => (
          <Box key={t.label} marginRight={2}>
            <Text bold={i === active} color={i === active ? "cyan" : undefined} underline={i === active}>
              {i + 1}:{t.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" height={contentHeight} overflow="hidden">
        {tabs[active]?.content(pageSize, scroll)}
      </Box>
      <Box>
        <Text dimColor>{isRawModeSupported ? "←/→ or 1-9: tabs   ↑/↓ PgUp/PgDn Home/End: scroll   q: quit" : "(non-interactive terminal -- controls disabled)"}</Text>
      </Box>
    </Box>
  );
}
