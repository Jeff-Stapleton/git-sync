import { App, FileSystemAdapter, Platform, requestUrl } from "obsidian";
import type { GitEngine } from "./GitEngine";
import { IsoGitEngine } from "./IsoGitEngine";
import { createObsidianFs } from "./obsidianFs";
import { createObsidianHttp } from "./obsidianHttp";

export type EngineChoice = "auto" | "cli" | "js";

/**
 * Desktop with a git binary -> CLI engine (fast, full git semantics). Otherwise (mobile, or no git on
 * PATH) -> isomorphic-git over Obsidian's file and network APIs. The CLI engine is loaded lazily:
 * it needs Node's child_process, which does not exist on mobile.
 */
export async function selectEngine(app: App, choice: EngineChoice): Promise<GitEngine> {
  const adapter = app.vault.adapter;
  if (choice !== "js" && Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
    const { CliGitEngine } = await import("./CliGitEngine");
    if (await CliGitEngine.isAvailable()) return new CliGitEngine(adapter.getBasePath());
    if (choice === "cli") throw new Error("git binary not found on PATH (engine is set to 'CLI').");
  } else if (choice === "cli") {
    throw new Error("The git CLI engine is only available in the desktop app.");
  }
  return new IsoGitEngine({ fs: createObsidianFs(adapter), http: createObsidianHttp(requestUrl), dir: "/" });
}
