/**
 * Build the Vercel deployment using the Build Output API (v3).
 *
 * Why not the plain `api/` directory: Vercel's Node runtime transforms those
 * entries, and with a root `"type": "module"` package the transformed module
 * failed to load at runtime (FUNCTION_INVOCATION_FAILED before any request).
 * The Build Output API skips all of that — we emit the exact function
 * directory Vercel runs, with its own CommonJS package.json, so there is no
 * runtime module-resolution or transformation left to go wrong.
 *
 * Produces:
 *   .vercel/output/config.json                      routing (CDN first, then app)
 *   .vercel/output/static/**                        the public/ UI, served by CDN
 *   .vercel/output/functions/api/index.func/        the bundled Express app
 *     index.js         self-contained CJS bundle (module.exports = app)
 *     package.json     { "type": "commonjs" }
 *     .vc-config.json  runtime config
 *     public/**        for the SPA fallback (res.sendFile) inside the function
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel", "output");
const funcDir = path.join(out, "functions", "api", "index.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(funcDir, { recursive: true });

// 1. Bundle the Express app to a single CommonJS file.
await build({
  entryPoints: [path.join(root, "src", "serverless.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(funcDir, "index.js"),
  // The entry uses `export default app`; make require() return the app itself.
  footer: { js: "module.exports = module.exports.default ?? module.exports;" },
  logLevel: "info",
});

// 2. Function runtime config + explicit CommonJS package type.
writeFileSync(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.js",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
    },
    null,
    2
  )
);
writeFileSync(
  path.join(funcDir, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2)
);

// 3. The UI: on the CDN for direct hits, and inside the function for the SPA fallback.
cpSync(path.join(root, "public"), path.join(out, "static"), { recursive: true });
cpSync(path.join(root, "public"), path.join(funcDir, "public"), { recursive: true });

// 4. Routing: serve static files first, everything else goes to the app.
writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/api/index" }],
    },
    null,
    2
  )
);

console.log("Build Output API bundle written to .vercel/output");
