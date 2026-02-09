require("dotenv").config();

const { initDb, getMigrationStatus, rollbackLastMigration } = require("../db");

async function main() {
  const command = process.argv[2] || "up";
  const { adapter, driver } = await initDb();

  try {
    if (command === "up") {
      const status = await getMigrationStatus(adapter, driver);
      console.log(JSON.stringify({ ok: true, command: "up", driver, pending: status.pending.length }, null, 2));
      return;
    }

    if (command === "status") {
      const status = await getMigrationStatus(adapter, driver);
      console.log(JSON.stringify({ ok: true, command: "status", driver, status }, null, 2));
      return;
    }

    if (command === "rollback") {
      const result = await rollbackLastMigration(adapter, driver);
      console.log(JSON.stringify({ ok: result.ok, command: "rollback", driver, result }, null, 2));
      process.exit(result.ok ? 0 : 1);
      return;
    }

    console.error(`Unknown command: ${command}`);
    process.exit(1);
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
