require("dotenv").config();

const { initDb } = require("../db");

const scope = process.argv[2] || "all";

(async () => {
  const { adapter } = await initDb();
  await adapter.reset(scope);
  await adapter.close();
  console.log(`Reset: ${scope}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
