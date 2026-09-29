import { App, PluginSettingTab, Setting } from "obsidian";
import type GitSyncPlugin from "./main";

export interface GitSyncSettings {
  remoteUrl: string;
  branch: string;
  token: string;
  deviceName: string;
  debounceSeconds: number;
  pullIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: GitSyncSettings = {
  remoteUrl: "",
  branch: "main",
  token: "",
  deviceName: "",
  debounceSeconds: 5,
  pullIntervalSeconds: 30,
};

export class GitSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitSyncPlugin) {
    super(app, plugin);
  }

  /** Apply connection/interval changes once, when the tab closes, not per keystroke. */
  hide(): void {
    void this.plugin.restart();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const text = (name: string, desc: string, key: "remoteUrl" | "branch" | "deviceName", ph = "", secret = false) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => {
        t.setPlaceholder(ph).setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v.trim();
          await this.plugin.saveSettings();
        });
        if (secret) t.inputEl.type = "password";
      });

    text("Origin URL", "HTTPS URL of the vault repository.", "remoteUrl", "https://github.com/you/vault.git");
    text("Branch", "Branch to sync.", "branch", "main");
    text("Device name", "Shown in commit messages.", "deviceName", "laptop");

    new Setting(containerEl)
      .setName("Access token")
      .setDesc("Personal access token with repo read/write. Never written to .git/config.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.token).onChange(async (v) => {
          this.plugin.settings.token = v.trim();
          await this.plugin.saveSettings();
        });
      });

    const num = (name: string, desc: string, key: "debounceSeconds" | "pullIntervalSeconds", min: number) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= min) {
            this.plugin.settings[key] = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    num("Push delay (seconds)", "Wait this long after your last edit before committing.", "debounceSeconds", 2);
    num("Pull interval (seconds)", "How often to check for remote changes.", "pullIntervalSeconds", 15);

    new Setting(containerEl).setName("Sync now").addButton((b) =>
      b.setButtonText("Sync").setCta().onClick(() => void this.plugin.syncNow()),
    );
  }
}
