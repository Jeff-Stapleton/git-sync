import { Notice, Platform, Plugin, SecretStorage } from "obsidian";
import type { GitEngine } from "./git/GitEngine";
import { selectEngine } from "./git/selectEngine";
import { DEFAULT_SETTINGS, GitSyncSettings, GitSyncSettingTab } from "./settings";
import { watchVault } from "./sync/ChangeWatcher";
import { SyncManager, SyncState } from "./sync/SyncManager";
import { ConfirmModal } from "./ui/ConfirmModal";
import { ConflictModal } from "./ui/ConflictModal";
import { LogModal } from "./ui/LogModal";
import { SyncScheduler } from "./sync/SyncScheduler";
import { friendlyError } from "./util/errors";
import { mergeGitignore } from "./util/ignore";
import { SyncLog } from "./util/log";
import { TokenStore } from "./util/tokenStore";

const PLUGIN_NAME = "auto sync: git";
const FOCUS_MIN_AGE_MS = 10_000;
/** Phones: fewer wake-ups, less battery and data. */
const MOBILE_MIN_PULL_S = 60;
const MB = 1024 * 1024;
const TOKEN_FILE = ".obsidian/plugins/git-sync/data.json";

export default class GitSyncPlugin extends Plugin {
  settings!: GitSyncSettings;
  private scheduler?: SyncScheduler;
  private manager?: SyncManager;
  private statusEl?: HTMLElement;
  private state: SyncState = { kind: "idle" };
  private lastSync?: number;
  private lastError?: string;
  private tokens!: TokenStore;
  private log = new SyncLog(300, () => this.getToken());

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    // Obsidian 1.11.4+ has per-device secret storage; older versions fall back to data.json.
    this.tokens = new TokenStore(this.app.secretStorage as SecretStorage | undefined, this.settings);
    if (this.tokens.migrate()) await this.saveSettings();
    this.addSettingTab(new GitSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("git-sync-status");
    this.statusEl.addEventListener("click", () => (this.state.kind === "conflict" ? this.openConflicts() : void this.syncNow()));
    this.render({ kind: "idle" });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "resolve-conflicts", name: "Resolve conflicts", callback: () => this.openConflicts() });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.log).open() });
    this.addCommand({ id: "open-repo", name: "Open repository in browser", callback: () => this.openRepo() });
    this.addRibbonIcon("refresh-cw", `${PLUGIN_NAME}: sync now`, () => void this.syncNow());

    // Keep "synced 12s ago" fresh.
    this.registerInterval(window.setInterval(() => this.render(this.state), 10_000));

    // Watchers must wait for layout-ready, or Obsidian's startup indexing looks like hundreds of edits.
    this.app.workspace.onLayoutReady(() => {
      watchVault(this, () => this.scheduler?.noteChange());
      this.registerDomEvent(window, "focus", () => void this.scheduler?.requestSyncIfStale(FOCUS_MIN_AGE_MS));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") void this.scheduler?.requestSyncIfStale(FOCUS_MIN_AGE_MS);
        // Going to the background: push pending edits now, the OS may suspend us before the debounce fires.
        else void this.scheduler?.requestSync();
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

  getToken(): string {
    return this.tokens.get();
  }

  async setToken(token: string) {
    if (this.tokens.set(token)) await this.saveSettings();
  }

  /** (Re)build engine + scheduler from current settings. Called at startup and when settings close. */
  async restart() {
    this.scheduler?.stop();
    this.scheduler = undefined;
    this.manager = undefined;
    if (!this.settings.remoteUrl) {
      this.render({ kind: "idle" });
      return;
    }
    try {
      const engine = await this.createEngine();
      const manager = new SyncManager(engine, () => this.settings.deviceName, (s) => this.onState(s), (m) => new Notice(`${PLUGIN_NAME}: ${m}`, 8000), {
        log: this.log,
        token: () => this.getToken(),
        warnBytes: this.settings.largeFileWarnMB * MB,
        confirmUnrelated: () =>
          ConfirmModal.ask(
            this.app,
            "Combine this vault with the repository?",
            `This vault already has notes, and ${this.settings.remoteUrl} has different notes with no shared history. ` +
              "Combining keeps both sets of notes and pushes the result. If you're not sure, cancel and point the plugin at an empty repository.",
            "Combine",
          ),
      });
      this.manager = manager;
      this.scheduler = new SyncScheduler({
        runSync: () => manager.sync(),
        debounceMs: () => this.settings.debounceSeconds * 1000,
        pullIntervalMs: () => Math.max(this.settings.pullIntervalSeconds, Platform.isMobile ? MOBILE_MIN_PULL_S : 0) * 1000,
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

    // Write ignore rules first so the token file is never staged.
    const existing = (await adapter.exists(".gitignore")) ? await adapter.read(".gitignore") : "";
    const merged = mergeGitignore(existing);
    if (merged !== null) await adapter.write(".gitignore", merged);

    const engine = await selectEngine(this.app, this.settings.engine);
    this.log.info(`Using engine: ${engine.name}`);
    const device = this.settings.deviceName || (Platform.isMobile ? "mobile" : "desktop");
    await engine.ensureRepo({
      remoteUrl: this.settings.remoteUrl,
      branch: this.settings.branch,
      token: this.getToken(),
      author: { name: device, email: `${device.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@obsidian-git-sync.local` },
    });
    await engine.untrack([TOKEN_FILE]); // in case an earlier setup already committed it
    return engine;
  }

  async syncNow() {
    if (!this.settings.remoteUrl) {
      new Notice(`${PLUGIN_NAME}: set the origin URL in settings first.`);
      return;
    }
    // Paused = waiting on a decision; a fresh manager asks again.
    if (!this.scheduler || this.state.kind === "paused") await this.restart();
    await this.scheduler?.requestSync();
    if (this.state.kind === "error") new Notice(`${PLUGIN_NAME}: ${this.state.message}`);
  }

  private openConflicts() {
    if (!this.manager) return void new Notice(`${PLUGIN_NAME}: not running. Set the origin URL in settings.`);
    new ConflictModal(this.app, this.manager, () => void this.scheduler?.requestSync()).open();
  }

  /** Notify once when a new set of conflicts appears, then render. */
  private onState(s: SyncState) {
    if (s.kind === "conflict" && this.state.kind !== "conflict") {
      new Notice(`${PLUGIN_NAME}: ${s.files.length} note(s) have merge conflicts. Click the status bar to resolve.`, 10000);
    }
    this.render(s);
  }

  async testConnection() {
    const { remoteUrl, branch } = this.settings;
    const token = this.getToken();
    if (!remoteUrl) return void new Notice(`${PLUGIN_NAME}: set the origin URL first.`);
    try {
      const engine = await selectEngine(this.app, this.settings.engine);
      const r = await engine.testConnection({ remoteUrl, branch, token });
      new Notice(
        r.branchExists
          ? `${PLUGIN_NAME}: connected. Branch "${branch}" found.`
          : `${PLUGIN_NAME}: connected. Branch "${branch}" doesn't exist yet; the first sync will create it.`,
      );
    } catch (e) {
      new Notice(`${PLUGIN_NAME}: connection failed. ${friendlyError(e, token)}`, 10000);
    }
  }

  private openRepo() {
    // https://host/owner/repo(.git) -> https://host/owner/repo
    const url = this.settings.remoteUrl.replace(/\/?(\.git)?\/?$/, "");
    if (!/^https?:\/\//.test(url)) return void new Notice(`${PLUGIN_NAME}: set an https origin URL first.`);
    window.open(url);
  }

  private fail(e: unknown) {
    const message = friendlyError(e, this.getToken());
    this.log.error(message);
    this.render({ kind: "error", message });
    new Notice(`${PLUGIN_NAME}: ${message}`);
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
      case "idle": el.setText(this.lastSync ? `✓ synced ${ago(this.lastSync)}` : PLUGIN_NAME); break;
      case "syncing": el.setText("⟳ syncing…"); break;
      case "offline": el.setText("☁✕ offline"); break;
      case "conflict": el.setText(`⚠ ${s.files.length} conflict(s)`); el.title = s.files.join("\n"); break;
      case "paused": el.setText("⏸ sync paused"); el.title = `${s.reason} Click to review.`; break;
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
