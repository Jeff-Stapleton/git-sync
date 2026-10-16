import { App, Modal, Notice, Setting } from "obsidian";
import type { SyncLog } from "../util/log";

/** Recent sync activity, with a copy button for bug reports. Tokens are redacted by SyncLog. */
export class LogModal extends Modal {
  constructor(app: App, private log: SyncLog) {
    super(app);
  }

  onOpen() {
    this.setTitle("Auto Git Sync log");
    const text = this.log.format() || "Nothing logged yet.";
    const pre = this.contentEl.createEl("pre", { text });
    pre.addClass("git-sync-log-output");
    pre.scrollTop = pre.scrollHeight;
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Copy").onClick(async () => {
        try {
          await navigator.clipboard.writeText(text);
          new Notice("Auto Git Sync: log copied.");
        } catch {
          new Notice("Auto Git Sync: couldn't access the clipboard; select the text and copy it.");
        }
      }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
