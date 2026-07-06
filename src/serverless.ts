/**
 * Serverless entry, bundled by esbuild into the Build Output API function
 * (see scripts/build-vercel.mjs). Re-exports the production app that
 * src/app.ts builds from the environment.
 */
export { default } from "./app.js";
