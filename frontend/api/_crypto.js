const crypto = require("crypto");
const ALGO = "aes-256-cbc";

function getKey() {
  const hex = (process.env.BANK_ENCRYPTION_KEY || "").replace(/\s/g, "");
  if (!hex) return null;
  if (hex.length !== 64) {
    console.error("[crypto] BANK_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Encryption disabled.");
    return null;
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext;
  const key = getKey();
  if (!key) {
    console.warn("[crypto] BANK_ENCRYPTION_KEY not set — storing bank detail in plaintext");
    return String(plaintext);
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return "v1:" + iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!String(ciphertext).startsWith("v1:")) return ciphertext; // legacy plaintext
  const key = getKey();
  if (!key) return "[key not configured]";
  try {
    const parts = String(ciphertext).split(":");
    if (parts.length !== 3) return "[invalid ciphertext]";
    const iv = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "[decryption error]";
  }
}

function isEncrypted(val) {
  return typeof val === "string" && val.startsWith("v1:");
}

module.exports = { encrypt, decrypt, isEncrypted };
