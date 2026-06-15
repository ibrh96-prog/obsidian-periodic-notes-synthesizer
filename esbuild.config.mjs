import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const builtins = [
  "obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab",
  "@codemirror/commands", "@codemirror/language", "@codemirror/lint",
  "@codemirror/search", "@codemirror/state", "@codemirror/view",
  "@lezer/common", "@lezer/highlight", "@lezer/lr",
  "node:assert", "node:buffer", "node:child_process", "node:crypto",
  "node:events", "node:fs", "node:http", "node:https", "node:os",
  "node:path", "node:stream", "node:url", "node:util", "node:zlib"
];

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: builtins,
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
