// macOS only, matching this project's one supported platform -- pipe
// directly into pbcopy's stdin rather than shelling through a string.
// Extracted out of TabView.tsx, which had this exact function private
// to itself; AssistApp.tsx's own "y" shortcut needs the same thing.
import { spawn } from "node:child_process";

export function copyToClipboard(text: string): void {
  const proc = spawn("pbcopy");
  proc.stdin.write(text);
  proc.stdin.end();
}
