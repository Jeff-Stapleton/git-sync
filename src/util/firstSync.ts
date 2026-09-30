/**
 * A vault is "trivial" if it holds nothing a person wrote: only the plugin's .gitignore and Obsidian's
 * own config. Merging unrelated histories into a trivial vault is the normal new-device case and needs
 * no confirmation; merging two real note collections does.
 */
export function isTrivialVault(trackedFiles: string[]): boolean {
  return trackedFiles.every((f) => f === ".gitignore" || f.startsWith(".obsidian/"));
}
