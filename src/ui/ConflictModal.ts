import { App, Modal, Setting, TFile } from "obsidian";
import type { SyncManager } from "../sync/SyncManager";

/** Lists files with unresolved merge conflicts; open one to edit markers, or take a whole side. */
export class ConflictModal extends Modal {
  constructor(app: App, private manager: SyncManager, private onDone: () => void) {
    super(app);
  }

  onOpen() {
    this.render(this.manager.currentConflicts());
  }

  private render(files: string[]) {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Sync conflicts");
    if (files.length === 0) {
      contentEl.createEl("p", { text: "No conflicts." });
      return;
    }
    contentEl.createEl("p", {
      text:
        "These notes were edited on two devices. Open a note and edit out the <<<<<<< ======= >>>>>>> markers, " +
        "or keep one whole version. Syncing resumes once all are resolved.",
    });
    for (const path of files) {
      new Setting(contentEl)
        .setName(path)
        .addButton((b) => b.setButtonText("Open").onClick(() => this.openNote(path)))
        .addButton((b) => b.setButtonText("Keep mine").onClick(() => void this.choose(path, "ours")))
        .addButton((b) => b.setButtonText("Keep theirs").onClick(() => void this.choose(path, "theirs")));
    }
  }

  private openNote(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
    this.close();
  }

  private async choose(path: string, side: "ours" | "theirs") {
    const left = await this.manager.resolve(path, side);
    this.render(left);
    if (left.length === 0) {
      this.close();
      this.onDone();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
