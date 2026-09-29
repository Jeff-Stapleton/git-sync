import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { CliGitEngine } from "./git/CliGitEngine";
import type { GitEngine } from "./git/GitEngine";
import { DEFAULT_SETTINGS, GitSyncSettings, GitSyncSettingTab } from "./settings";
import { watchVault } from "./sync/ChangeWatcher";
import { SyncManager, SyncState } from "./sync/SyncManager";
import { SyncScheduler } from "./sync/SyncScheduler";
import { mergeGitignore } from "./util/ignore";

const FOCUS_MIN_AGE_MS = 10_000;
const TOKEN_FILE = ".obsidian/plugins/git-sync/data.json";

export default class GitSyncPlugin extends Plugin {
  settings!: GitSyncSettings;
  private scheduler?: SyncScheduler;
  private statusEl?: HTMLElement;
  private state: SyncState = { kind: "idle" };
  private lastSync?: number;
  private lastError?: string;

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.addSettingTab(new GitSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("git-sync-status");
    this.statusEl.addEventListener("click", () => void this.syncNow());
    this.render({ kind: "idle" });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addRibbonIcon("refresh-cw", "Git Sync: sync now", () => void this.syncNow());

    // Keep "synced 12s ago" fresh.
    this.registerInterval(window.setInterval(() => this.render(this.state), 10_000));

    // Watchers must wait for layout-ready, or Obsidian's startup indexing looks like hundreds of edits.
    this.app.workspace.onLayoutReady(() => {
      watchVault(this, () => this.scheduler?.noteChange());
      this.registerDomEvent(window, "focus", () => void this.scheduler?.requestSyncIfStale(FOCUS_MIN_AGE_MS));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") void this.scheduler?.requestSyncIfStale(FOCUS_MIN_AGE_MS);
      });
      this.registerDomEvent(window, "online", () => void this.scheduler?.requestSync());
      this.registerDomEvent(window, "offline", () => this.render({ kind: "offline" }));
      void this.restart();
    });
  }

  onunload() {
    this.scheduler?.stop();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** (Re)build engine + scheduler from current settings. Called at startup and when settings close. */
  async restart() {
    this.scheduler?.stop();
    this.scheduler = undefined;
    if (!this.settings.remoteUrl) {
      this.render({ kind: "idle" });
      return;
    }
    try {
      const engine = await this.createEngine();
      const manager = new SyncManager(engine, () => this.settings.deviceName, (s) => this.render(s));
      this.scheduler = new SyncScheduler({
        runSync: () => manager.sync(),
        debounceMs: () => this.settings.debounceSeconds * 1000,
        pullIntervalMs: () => this.settings.pullIntervalSeconds * 1000,
        isOnline: () => navigator.onLine,
        onOffline: () => this.render({ kind: "offline" }),
      });
      this.scheduler.start();
    } catch (e) {
      this.fail(e);
    }
  }

  private async createEngine(): Promise<GitEngine> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Mobile engine (isomorphic-git) is not implemented yet.");
    }
    if (!(await CliGitEngine.isAvailable())) throw new Error("git binary not found on PATH.");

    // Write ignore rules first so the token file is never staged.
    const existing = (await adapter.exists(".gitignore")) ? await adapter.read(".gitignore") : "";
    const merged = mergeGitignore(existing);
    if (merged !== null) await adapter.write(".gitignore", merged);

    const engine = new CliGitEngine(adapter.getBasePath());
    await engine.ensureRepo({
      remoteUrl: this.settings.remoteUrl,
      branch: this.settings.branch,
      token: this.settings.token,
    });
    await engine.untrack([TOKEN_FILE]); // in case an earlier setup already committed it
    return engine;
  }

  async syncNow() {
    if (!this.settings.remoteUrl) {
      new Notice("Git Sync: set the origin URL in settings first.");
      return;
    }
    if (!this.scheduler) await this.restart();
    await this.scheduler?.requestSync();
    if (this.state.kind === "error") new Notice(`Git Sync: ${this.state.message}`);
  }

  private fail(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    this.render({ kind: "error", message });
    new Notice(`Git Sync: ${message}`);
  }

  private render(s: SyncState) {
    this.state = s;
    if (s.kind === "idle" && s.lastSync) this.lastSync = s.lastSync;
    if (s.kind === "error") this.lastError = s.message;
    const el = this.statusEl;
    if (!el) return;
    el.toggleClass("is-conflict", s.kind === "conflict");
    el.title = "";
    switch (s.kind) {
      case "idle": el.setText(this.lastSync ? `✓ synced ${ago(this.lastSync)}` : "Git Sync"); break;
      case "syncing": el.setText("⟳ syncing…"); break;
      case "offline": el.setText("☁✕ offline"); break;
      case "conflict": el.setText(`⚠ ${s.files.length} conflict(s)`); el.title = s.files.join("\n"); break;
      case "error": el.setText("⚠ sync error (retrying)"); el.title = this.lastError ?? s.message; break;
    }
  }
}

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
