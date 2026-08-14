import { startServer } from "./app.js";

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  process.stderr.write(`${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
