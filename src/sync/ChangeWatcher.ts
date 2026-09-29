import type { Plugin, TAbstractFile } from "obsidian";
import { isIgnoredPath } from "../util/ignore";

/** Forwards relevant vault changes (including dot-folders like .obsidian) to `onChange`. */
export function watchVault(plugin: Plugin, onChange: () => void) {
  const { vault } = plugin.app;
  const fire = (f: TAbstractFile) => {
    if (!isIgnoredPath(f.path)) onChange();
  };
  plugin.registerEvent(vault.on("create", fire));
  plugin.registerEvent(vault.on("modify", fire));
  plugin.registerEvent(vault.on("delete", fire));
  plugin.registerEvent(vault.on("rename", (f, oldPath) => {
    if (!isIgnoredPath(f.path) || !isIgnoredPath(oldPath)) onChange();
  }));
  // `raw` (not in the public typings) also reports changes inside hidden folders such as .obsidian.
  // Best-effort: the periodic pull tick commits anything dirty even if this never fires.
  const raw = vault as unknown as { on(name: "raw", cb: (path: string) => void): import("obsidian").EventRef };
  plugin.registerEvent(raw.on("raw", (path) => {
    if (!isIgnoredPath(path)) onChange();
  }));
}
