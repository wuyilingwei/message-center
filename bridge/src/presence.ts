import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import type { PresenceSnapshot, PresenceState } from "./types.js";

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));

interface PresenceScriptResult {
  idleSeconds: number;
  sessionLocked: boolean;
  observedAt: string;
}

export class PresenceService {
  constructor(private readonly config: AppConfig) {}

  async snapshot(): Promise<PresenceSnapshot> {
    if (process.platform !== "win32") return this.fallback();
    const scriptPath = resolve(moduleDir, "../scripts/presence.ps1");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath
      ], { windowsHide: true, timeout: 5000 });
      const parsed = JSON.parse(stdout.trim()) as PresenceScriptResult;
      return {
        state: this.classify(parsed.idleSeconds, parsed.sessionLocked),
        idleSeconds: parsed.idleSeconds,
        sessionLocked: parsed.sessionLocked,
        observedAt: parsed.observedAt,
        source: "windows"
      };
    } catch {
      return this.fallback();
    }
  }

  private classify(idleSeconds: number, sessionLocked: boolean): PresenceState {
    if (sessionLocked) return "locked";
    if (idleSeconds >= this.config.presence.awayAfterSeconds) return "away_unlocked";
    if (idleSeconds >= this.config.presence.quiescentAfterSeconds) return "quiescent";
    return "active";
  }

  private fallback(): PresenceSnapshot {
    return {
      state: "unknown",
      idleSeconds: null,
      sessionLocked: null,
      observedAt: new Date().toISOString(),
      source: "fallback"
    };
  }
}
