import { describe, expect, it } from "vitest";
import { TOKEN_SECRET_ID, TokenStore } from "../src/util/tokenStore";

const secrets = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getSecret: (id: string) => m.get(id) ?? null, setSecret: (id: string, v: string) => void m.set(id, v), m };
};

describe("TokenStore", () => {
  it("without secret storage, keeps the token in data", () => {
    const data = { token: "" };
    const t = new TokenStore(undefined, data);
    expect(t.set("abc")).toBe(true);
    expect(data.token).toBe("abc");
    expect(t.get()).toBe("abc");
    expect(t.set("abc")).toBe(false); // unchanged: nothing to save
  });

  it("with secret storage, the token never lands in data", () => {
    const s = secrets();
    const data = { token: "" };
    const t = new TokenStore(s, data);
    expect(t.set("abc")).toBe(false);
    expect(data.token).toBe("");
    expect(s.m.get(TOKEN_SECRET_ID)).toBe("abc");
    expect(t.get()).toBe("abc");
  });

  it("migrates a token from data.json and asks for a save", () => {
    const s = secrets();
    const data = { token: "old" };
    const t = new TokenStore(s, data);
    expect(t.migrate()).toBe(true);
    expect(data.token).toBe("");
    expect(t.get()).toBe("old");
    expect(t.migrate()).toBe(false);
  });

  it("migration never overwrites a token already in secret storage", () => {
    const s = secrets({ [TOKEN_SECRET_ID]: "new" });
    const t = new TokenStore(s, { token: "stale" });
    t.migrate();
    expect(t.get()).toBe("new");
  });

  it("clears data.json when saving through secret storage", () => {
    const data = { token: "old" };
    const t = new TokenStore(secrets(), data);
    expect(t.set("fresh")).toBe(true);
    expect(data.token).toBe("");
  });
});
