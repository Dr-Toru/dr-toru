type DiagnosticValue = string | number | boolean | null;

export type DiagnosticData = Record<string, DiagnosticValue | undefined>;

type DiagnosticKind = "start" | "beat" | "event" | "stop";

interface SessionState {
  sessionId: string;
  startedAt: number;
  lastBeatAt: number;
  clean: boolean;
  endedAt?: number;
}

interface DiagnosticEntry {
  t: number;
  sessionId: string;
  kind: DiagnosticKind;
  data: DiagnosticData;
}

const STATE_KEY = "toru.diag.state.v1";
const LOG_KEY = "toru.diag.log.v1";
const DEFAULT_BEAT_MS = 15000;
const DEFAULT_MAX_ENTRIES = 240;

function asJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function makeSessionId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

export class SessionDiagnostics {
  private readonly state: SessionState;
  private readonly previousState: SessionState | null;
  private beatTimerId: number | null = null;
  private getBeatData: (() => DiagnosticData) | null = null;

  constructor(
    private readonly storage: Storage | null,
    private readonly beatMs = DEFAULT_BEAT_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    const now = Date.now();
    this.previousState = this.readState();
    this.state = {
      sessionId: makeSessionId(now),
      startedAt: now,
      lastBeatAt: now,
      clean: false,
    };
    this.writeState(this.state);
    this.append({
      t: now,
      sessionId: this.state.sessionId,
      kind: "start",
      data: {
        userAgent: navigator.userAgent,
      },
    });
  }

  start(getBeatData: () => DiagnosticData): void {
    this.getBeatData = getBeatData;
    this.beat();
    this.beatTimerId = window.setInterval(() => this.beat(), this.beatMs);
  }

  stop(clean = true): void {
    if (this.beatTimerId !== null) {
      window.clearInterval(this.beatTimerId);
      this.beatTimerId = null;
    }
    if (clean) {
      this.state.clean = true;
      this.state.endedAt = Date.now();
    }
    this.writeState(this.state);
    this.append({
      t: Date.now(),
      sessionId: this.state.sessionId,
      kind: "stop",
      data: {
        clean: this.state.clean,
      },
    });
  }

  recordEvent(event: string, data: DiagnosticData = {}): void {
    this.append({
      t: Date.now(),
      sessionId: this.state.sessionId,
      kind: "event",
      data: {
        event,
        ...data,
      },
    });
  }

  getPreviousUncleanSummary(): string | null {
    if (!this.previousState || this.previousState.clean) {
      return null;
    }
    const last = this.getLastEntry(this.previousState.sessionId);
    const ts = last?.t ?? this.previousState.lastBeatAt;
    return `${toIso(ts)} (session ${this.previousState.sessionId})`;
  }

  getSummary(): string {
    const unclean = this.getPreviousUncleanSummary();
    const state = this.readState();
    const tail = this.readLog().slice(-1)[0];
    const lastTs = tail?.t ?? state?.lastBeatAt ?? this.state.lastBeatAt;
    const parts = [
      `Current session: ${this.state.sessionId}`,
      `Last beat: ${toIso(lastTs)}`,
    ];
    if (unclean) {
      parts.push(`Previous unclean exit: ${unclean}`);
    }
    return parts.join(" | ");
  }

  getReport(limit = 120): string {
    const entries = this.readLog().slice(-limit);
    if (entries.length === 0) {
      return "(no diagnostics entries)";
    }
    return entries
      .map(
        (entry) =>
          `[${toIso(entry.t)}] ${entry.kind.toUpperCase()} ${entry.sessionId} ${asJson(entry.data)}`,
      )
      .join("\n");
  }

  clear(): void {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.removeItem(LOG_KEY);
    } catch {
      // ignore storage errors
    }
    this.recordEvent("diagnostics-cleared");
  }

  private beat(): void {
    if (!this.getBeatData) {
      return;
    }
    const now = Date.now();
    this.state.lastBeatAt = now;
    this.writeState(this.state);
    this.append({
      t: now,
      sessionId: this.state.sessionId,
      kind: "beat",
      data: this.getBeatData(),
    });
  }

  private getLastEntry(sessionId: string): DiagnosticEntry | null {
    const entries = this.readLog();
    for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
      if (entries[idx].sessionId === sessionId) {
        return entries[idx];
      }
    }
    return null;
  }

  private append(entry: DiagnosticEntry): void {
    if (!this.storage) {
      return;
    }
    try {
      const entries = this.readLog();
      entries.push(entry);
      if (entries.length > this.maxEntries) {
        entries.splice(0, entries.length - this.maxEntries);
      }
      this.storage.setItem(LOG_KEY, JSON.stringify(entries));
    } catch {
      // ignore storage errors
    }
  }

  private readState(): SessionState | null {
    if (!this.storage) {
      return null;
    }
    return parseJson<SessionState>(this.storage.getItem(STATE_KEY));
  }

  private writeState(nextState: SessionState): void {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(STATE_KEY, JSON.stringify(nextState));
    } catch {
      // ignore storage errors
    }
  }

  private readLog(): DiagnosticEntry[] {
    if (!this.storage) {
      return [];
    }
    const parsed = parseJson<DiagnosticEntry[]>(this.storage.getItem(LOG_KEY));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry) =>
        typeof entry?.t === "number" &&
        typeof entry?.sessionId === "string" &&
        typeof entry?.kind === "string" &&
        typeof entry?.data === "object" &&
        entry.data !== null,
    );
  }
}
