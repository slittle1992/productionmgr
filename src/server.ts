import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, usingSampleData } = buildApp({ config });

app.listen(config.port, () => {
  console.log(
    `Production Manager app listening on http://localhost:${config.port}`
  );
  if (usingSampleData) {
    console.log(
      "⚠  No Builder Prime credentials found — serving SAMPLE data. " +
        "Set BUILDER_PRIME_SUBDOMAIN and BUILDER_PRIME_API_KEY for live data."
    );
  } else {
    console.log(
      `Connected to Builder Prime (${config.builderPrime.subdomain}.builderprime.com).`
    );
  }
});
