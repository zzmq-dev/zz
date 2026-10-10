// A capped ring buffer the work loop pushes agent activity lines into,
// and the TUI polls on its own render interval -- simpler than real
// pub/sub for a terminal view that's already redrawing on a timer.
export class LogBuffer {
  private lines: string[] = [];
  constructor(private max = 4000) {}

  push(line: string): void {
    for (const part of line.split("\n")) this.lines.push(part);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  get all(): readonly string[] {
    return this.lines;
  }
}
