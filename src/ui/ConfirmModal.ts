import { App, Modal, Setting } from "obsidian";

/** Promise-based yes/no dialog. Closing it any other way counts as "no". */
export class ConfirmModal extends Modal {
  private answered = false;

  private constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText: string,
    private done: (ok: boolean) => void,
  ) {
    super(app);
  }

  static ask(app: App, title: string, message: string, confirmText = "Continue"): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, message, confirmText, resolve).open());
  }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText(this.confirmText).setCta().onClick(() => this.answer(true)));
  }

  private answer(ok: boolean) {
    this.answered = true;
    this.done(ok);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.answered) this.done(false);
  }
}
