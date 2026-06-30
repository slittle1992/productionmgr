/**
 * Serverless entry, bundled by esbuild into `api/index.js` for Vercel.
 *
 * Bundling produces one self-contained file, so there is no runtime module
 * resolution — which is what avoids the `.js`→`.ts` ESM resolution failure that
 * crashes an un-bundled function on Vercel. The standalone `src/server.ts` is
 * still used for local `npm start`.
 */
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const { app } = buildApp({ config: loadConfig() });

export default app;
