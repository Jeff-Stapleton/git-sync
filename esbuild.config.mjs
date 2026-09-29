import esbuild from "esbuild";
import process from "process";
import { sharedOptions } from "./esbuild.shared.mjs";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  ...sharedOptions,
  entryPoints: ["src/main.ts"],
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
