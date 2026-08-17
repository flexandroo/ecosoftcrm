import crypto from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash || "").split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = await scrypt(String(password || ""), salt);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookie(token, maxAgeSeconds) {
  return [
    `ecosoftcrm_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function clearSessionCookie() {
  return "ecosoftcrm_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

export function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}
