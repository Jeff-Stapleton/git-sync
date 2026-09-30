import { redact } from "./errors";

export type LogLevel = "info" | "warn" | "error";
export interface LogEntry {
  time: number;
  level: LogLevel;
  msg: string;
}

/** In-memory ring buffer of recent sync activity, for the "Show sync log" command. */
export class SyncLog {
  private entries: LogEntry[] = [];

  constructor(private max = 300, private token: () => string = () => "") {}

  add(level: LogLevel, msg: string) {
    this.entries.push({ time: Date.now(), level, msg: redact(msg, this.token()) });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }
  info(msg: string) { this.add("info", msg); }
  warn(msg: string) { this.add("warn", msg); }
  error(msg: string) { this.add("error", msg); }

  get all(): readonly LogEntry[] {
    return this.entries;
  }

  format(): string {
    return this.entries
      .map((e) => `${new Date(e.time).toISOString().slice(11, 19)} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`)
      .join("\n");
  }
}
