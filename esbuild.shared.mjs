import builtins from "builtin-modules";

// `buffer` is NOT external: it must be bundled (the npm polyfill) because mobile has no Node builtins.
const nodeBuiltins = builtins.filter((m) => m !== "buffer");

/** Options shared by the plugin build and the mobile-compat smoke build. */
export const sharedOptions = {
  bundle: true,
  format: "cjs",
  target: "es2020",
  treeShaking: true,
  inject: ["src/shims/buffer.ts"],
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...nodeBuiltins],
};
