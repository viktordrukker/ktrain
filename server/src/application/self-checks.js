const { migrationStatus } = require("../../db/migration-runner");
const { SAFE_CONFIG_KEYS } = require("../infrastructure/config/config-store");

async function checkConfigSchema(configStore) {
  const rows = await configStore.list({ scope: "global", scopeId: "global" });
  const invalid = rows.filter((row) => !SAFE_CONFIG_KEYS.has(row.key));
  return {
    ok: invalid.length === 0,
    invalidKeys: invalid.map((row) => row.key)
  };
}

async function checkMigrations(repo, driver) {
  const status = await migrationStatus(repo, driver);
  return {
    ok: status.pending.length === 0,
    pending: status.pending,
    total: status.total,
    applied: status.applied.length
  };
}

async function checkRequiredIndexes(repo) {
  const required = ["idx_leaderboard_sort", "idx_vocab_packs_packtype_active"];
  const missing = [];
  for (const indexName of required) {
    const exists = await repo.hasIndex(indexName);
    if (!exists) missing.push(indexName);
  }
  return {
    ok: missing.length === 0,
    missing
  };
}

function checkEncryption(encryptionService) {
  return encryptionService.selfCheckRoundtrip();
}

module.exports = {
  checkConfigSchema,
  checkMigrations,
  checkRequiredIndexes,
  checkEncryption
};
