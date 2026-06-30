/**
 * Vercel serverless entry point.
 *
 * Builds the same Express app used by the standalone server and exports it as
 * the request handler. Vercel's @vercel/node runtime invokes the default export
 * for every request routed here (see vercel.json rewrites). The standalone
 * `src/server.ts` is still used for local `npm start`.
 */
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const { app } = buildApp({ config: loadConfig() });

export default app;
