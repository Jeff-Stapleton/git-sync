import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { CliGitEngine } from "./git/CliGitEngine";
import type { GitEngine } from "./git/GitEngine";
import { DEFAULT_SETTINGS, GitSyncSettings, GitSyncSettingTab } from "./settings";
import { SyncManager, SyncState } from "./sync/SyncManager";

export default class GitSyncPlugin extends Plugin {
  settings!: GitSyncSettings;
  private sync?: SyncManager;
  private statusEl?: HTMLElement;

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.addSettingTab(new GitSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("git-sync-status");
    this.render({ kind: "idle" });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addRibbonIcon("refresh-cw", "Git Sync: sync now", () => this.syncNow());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.sync = undefined; // rebuild engine with new settings on next sync
  }

  private async createEngine(): Promise<GitEngine> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Mobile engine (isomorphic-git) is not implemented yet.");
    }
    if (!(await CliGitEngine.isAvailable())) throw new Error("git binary not found on PATH.");
    const engine = new CliGitEngine(adapter.getBasePath());
    await engine.ensureRepo({
      remoteUrl: this.settings.remoteUrl,
      branch: this.settings.branch,
      token: this.settings.token,
    });
    return engine;
  }

  async syncNow() {
    if (!this.settings.remoteUrl) {
      new Notice("Git Sync: set the origin URL in settings first.");
      return;
    }
    try {
      if (!this.sync) {
        const engine = await this.createEngine();
        this.sync = new SyncManager(engine, () => this.settings.deviceName, (s) => this.render(s));
      }
      const s = await this.sync.sync();
      if (s.kind === "error") new Notice(`Git Sync: ${s.message}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.render({ kind: "error", message });
      new Notice(`Git Sync: ${message}`);
    }
  }

  private render(s: SyncState) {
    if (!this.statusEl) return;
    this.statusEl.toggleClass("is-conflict", s.kind === "conflict");
    switch (s.kind) {
      case "idle": this.statusEl.setText(s.lastSync ? "✓ synced" : "Git Sync"); break;
      case "syncing": this.statusEl.setText("⟳ syncing"); break;
      case "conflict": this.statusEl.setText(`⚠ ${s.files.length} conflict(s)`); break;
      case "error": this.statusEl.setText("⚠ sync error"); this.statusEl.title = s.message; break;
    }
  }
}
