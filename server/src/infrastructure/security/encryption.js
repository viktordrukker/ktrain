const crypto = require("crypto");

function resolveMasterKey(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^[A-Fa-f0-9]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  try {
    const key = Buffer.from(value, "base64");
    if (key.length === 32) return key;
  } catch {
    return null;
  }
  return null;
}

class EncryptionService {
  constructor(masterKey) {
    this.masterKey = resolveMasterKey(masterKey);
  }

  isConfigured() {
    return Boolean(this.masterKey);
  }

  encrypt(plaintext) {
    if (!this.masterKey) throw new Error("KTRAIN_MASTER_KEY is not configured");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64")
    };
  }

  decrypt({ ciphertext, iv, authTag }) {
    if (!this.masterKey) throw new Error("KTRAIN_MASTER_KEY is not configured");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  }

  selfCheckRoundtrip() {
    if (!this.masterKey) return { ok: false, reason: "master_key_missing" };
    const probe = `probe-${Date.now()}`;
    const encrypted = this.encrypt(probe);
    const decrypted = this.decrypt(encrypted);
    return { ok: decrypted === probe };
  }
}

module.exports = {
  EncryptionService
};
