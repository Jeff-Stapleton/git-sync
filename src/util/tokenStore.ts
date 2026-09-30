export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export const TOKEN_SECRET_ID = "git-sync-token";

/**
 * Keeps the access token out of the vault when Obsidian offers per-device secret storage (1.11.4+).
 * On older versions it falls back to the plugin's data.json (which the default .gitignore keeps out
 * of git). `data` is the object that gets persisted; callers save it whenever these return true.
 */
export class TokenStore {
  constructor(private secrets: SecretStore | undefined, private data: { token: string }) {}

  get(): string {
    if (!this.secrets) return this.data.token;
    return this.secrets.getSecret(TOKEN_SECRET_ID) ?? this.data.token;
  }

  /** Returns true if `data` changed and needs saving. */
  set(token: string): boolean {
    if (!this.secrets) {
      const changed = this.data.token !== token;
      this.data.token = token;
      return changed;
    }
    this.secrets.setSecret(TOKEN_SECRET_ID, token);
    const changed = this.data.token !== "";
    this.data.token = "";
    return changed;
  }

  /** Move a token saved by an earlier version out of data.json. Returns true if `data` changed. */
  migrate(): boolean {
    if (!this.secrets || !this.data.token) return false;
    if (!this.secrets.getSecret(TOKEN_SECRET_ID)) this.secrets.setSecret(TOKEN_SECRET_ID, this.data.token);
    this.data.token = "";
    return true;
  }
}
