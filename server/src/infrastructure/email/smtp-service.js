const nodemailer = require("nodemailer");

class SmtpService {
  constructor({ configStore, repo, encryptionService }) {
    this.configStore = configStore;
    this.repo = repo;
    this.encryptionService = encryptionService;
  }

  async getEmailSettings() {
    const settings = await this.configStore.get("service.email", {
      scope: "global",
      scopeId: "global",
      fallback: {
        enabled: false,
        host: "",
        port: 587,
        secure: false,
        username: "",
        fromAddress: "",
        fromName: "KTrain"
      }
    });
    const secret = await this.repo.getSystemSecret("smtp.password");
    const password = secret
      ? this.encryptionService.decrypt({
          ciphertext: secret.ciphertext,
          iv: secret.iv,
          authTag: secret.authtag || secret.authTag
        })
      : "";
    return { ...settings, password };
  }

  async saveEmailSettings(input, updatedBy) {
    const safe = {
      enabled: Boolean(input.enabled),
      host: String(input.host || "").trim(),
      port: Number(input.port || 587),
      secure: Boolean(input.secure),
      username: String(input.username || "").trim(),
      fromAddress: String(input.fromAddress || "").trim(),
      fromName: String(input.fromName || "KTrain").trim()
    };
    await this.configStore.setSafe("service.email", safe, {
      scope: "global",
      scopeId: "global",
      updatedBy
    });

    if (input.password) {
      // SECURITY: SMTP password is encrypted at rest and never returned by API.
      const encrypted = this.encryptionService.encrypt(String(input.password));
      await this.repo.setSystemSecret("smtp.password", encrypted, updatedBy);
    }
    return safe;
  }

  async send({ to, subject, text, html }) {
    const settings = await this.getEmailSettings();
    if (!settings.enabled) {
      throw new Error("Email service is disabled");
    }
    if (!settings.host || !settings.username || !settings.password || !settings.fromAddress) {
      throw new Error("Email settings are incomplete");
    }
    const transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: Boolean(settings.secure),
      auth: {
        user: settings.username,
        pass: settings.password
      }
    });
    return transporter.sendMail({
      from: settings.fromName ? `\"${settings.fromName}\" <${settings.fromAddress}>` : settings.fromAddress,
      to,
      subject,
      text,
      html
    });
  }

  async testSettings(input = {}, testRecipient = null) {
    const current = await this.getEmailSettings();
    const merged = {
      ...current,
      ...input,
      enabled: Boolean(input.enabled ?? current.enabled),
      password: String(input.password || current.password || "")
    };
    if (!merged.enabled) {
      throw new Error("Email service is disabled");
    }
    if (!merged.host || !merged.username || !merged.password || !merged.fromAddress) {
      throw new Error("Email settings are incomplete");
    }
    const transporter = nodemailer.createTransport({
      host: merged.host,
      port: Number(merged.port || 587),
      secure: Boolean(merged.secure),
      auth: {
        user: merged.username,
        pass: merged.password
      }
    });
    await transporter.verify();
    if (testRecipient) {
      await transporter.sendMail({
        from: merged.fromName ? `\"${merged.fromName}\" <${merged.fromAddress}>` : merged.fromAddress,
        to: testRecipient,
        subject: "KTrain SMTP test",
        text: "SMTP test message from KTrain admin settings.",
        html: "<p>SMTP test message from KTrain admin settings.</p>"
      });
    }
    return { ok: true };
  }
}

module.exports = {
  SmtpService
};
