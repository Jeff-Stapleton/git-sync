# auto sync: git for Obsidian

Keeps your vault in sync across devices through a git repository, the way Obsidian Sync does:
it commits and pushes your edits shortly after you make them and pulls other devices' changes
every 30 seconds. No buttons to press.

- **Desktop** uses your system `git` (fast, full git behaviour).
- **Mobile** (and desktop without git) uses a built-in JavaScript git, so iOS and Android work too.
- **Conflicts** are ordinary git merges. Edits to different parts of the same note merge
  automatically; genuinely overlapping edits leave standard `<<<<<<<` markers you resolve in the note.

## Install

**With BRAT (recommended while this is unpublished):** install the *BRAT* community plugin, run
*BRAT: Add a beta plugin*, and enter this repository's GitHub URL. Do this on every device.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from a release into
`<vault>/.obsidian/plugins/git-sync/`, then enable *auto sync: git* in Settings → Community plugins.

## Set up

1. Create an **empty, private** repository on GitHub (or any host that supports HTTPS git).
2. Create an access token that can read and write that repository.
   On GitHub: Settings → Developer settings → *Fine-grained tokens* → repository access to just this
   repo, permission **Contents: Read and write**.
3. In *Settings → auto sync: git* enter the repository's HTTPS URL (`https://github.com/you/vault.git`),
   the branch, your token and a device name (used in commit messages).
4. Press **Test connection**, then close the settings. The first sync starts immediately.

On your other devices, install the plugin and enter the same URL, branch and token.

### Adding a second device

Start with a fresh, empty vault (or one with only Obsidian's own settings). The plugin adopts
everything from the repository. If the device already has **its own notes** and the repository
has different notes with no shared history, you'll be asked before they are combined.

## How it behaves

| Event | What happens |
| --- | --- |
| You edit a note | ~5 s after you stop typing (30 s at most during continuous typing), it commits and pushes |
| Every 30 s (60 s on mobile) | Checks the remote and pulls new changes |
| Obsidian opens, regains focus, or the network returns | Syncs right away |
| App goes to the background | Pushes pending edits immediately |
| Offline | Keeps committing locally, retries with growing delays, pushes when back online |

The status bar shows `✓ synced 12s ago`, `⟳ syncing…`, `☁✕ offline`, `⏸ sync paused`,
`⚠ N conflict(s)` or `⚠ sync error`. Clicking it syncs, or opens the conflict list.

### Conflicts

- **Different parts of one note:** merged automatically.
- **Same lines edited on two devices:** the note gets conflict markers and sync holds until you resolve it.
  Click the status bar (or run *Resolve conflicts*) to open the note, or keep your whole version or the
  remote's. Once the markers are gone, syncing resumes by itself.
- **Binary file changed on both sides** (e.g. an image): your version stays; the other is saved next to it as
  `name.conflict-remote-<timestamp>.ext`.
- **Deleted on one device, edited on another:** the edited file is kept.
- **Files in `.obsidian/`** (Obsidian settings): the remote version wins.

### What is not synced

`.obsidian/workspace.json`, `workspace-mobile.json`, `.obsidian/cache`, `.trash/`, `.DS_Store` and this
plugin's own folder (`.obsidian/plugins/git-sync`) are added to `.gitignore` automatically. Files over **100 MB** are never synced
(git hosts reject them, and one such file would make every push fail); you'll get a notice. Files over
25 MB (configurable) sync but produce a warning.

## Commands

*Sync now*, *Resolve conflicts*, *Show sync log* (with a copy button for bug reports; tokens are
redacted), *Open repository in browser*.

## Security

- The token is kept in Obsidian's per-device secret storage (Obsidian 1.11.4+). On older versions it is
  stored in the plugin's `data.json` **in plain text**; that file is git-ignored but is readable on disk.
- The CLI engine passes the token through environment variables, so it is not visible in the process list
  and is never written to `.git/config`. The built-in engine sends it as an `Authorization` header.
- Use a fine-grained token limited to the vault repository.
- Your notes live in git history. Deleting a note does not remove it from the repository's history.

## Troubleshooting

Run **Show sync log** first. Common messages:

- *Authentication failed*: token is wrong, expired, or lacks write access to this repository.
- *Repository not found*: check the URL. Private repositories also report this for a bad token.
- *Can't reach the git host*: offline; it retries on its own.
- *Sync paused*: the vault and repository both hold notes with no shared history. Click the status bar
  to be asked again, or point the plugin at an empty repository.

## Limitations

- No Git LFS, so keep large attachments out of the vault or accept the 100 MB ceiling.
- One vault per repository. One branch.
- On mobile, requests and pushes are held in memory; a very large *first* push may be slow or fail on a phone.
  Do the first sync from your desktop.
- No built-in per-note history or restore UI; use your git host or any git client.
- Very large vaults (many thousands of files) make the built-in engine slower than system git.

## Development

```sh
npm install
npm run dev      # rebuilds main.js on change; symlink this folder into <vault>/.obsidian/plugins/git-sync
npm run build    # type-check + production bundle
npm test         # unit tests + engine contract tests against a local git HTTP server
```

The engine contract tests run the same scenarios against three setups: system git, the built-in engine on
Node's `fs`, and the built-in engine through the Obsidian file and network bridges. `tests/mobile-compat.test.ts`
loads the real bundle in a sandbox with no Node modules, `Buffer` or `process` and runs a two-device sync there.

Releasing: `npm version patch` (updates `manifest.json` and `versions.json`), then push the commit and the
tag; the *Release* workflow builds, tests and publishes `main.js`, `manifest.json`, `styles.css`.
