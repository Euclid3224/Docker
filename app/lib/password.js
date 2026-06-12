"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Пароль должен содержать не менее 12 символов.");
  }

  if (password.length > 200) {
    throw new Error("Пароль слишком длинный.");
  }
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);

  return [
    "scrypt",
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

async function verifyPassword(password, encodedHash) {
  try {
    const [algorithm, n, r, p, saltValue, hashValue] = String(encodedHash).split("$");

    if (algorithm !== "scrypt" || !saltValue || !hashValue) {
      return false;
    }

    const salt = Buffer.from(saltValue, "base64");
    const expectedHash = Buffer.from(hashValue, "base64");
    const actualHash = await scrypt(password, salt, expectedHash.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_OPTIONS.maxmem,
    });

    return (
      actualHash.length === expectedHash.length &&
      crypto.timingSafeEqual(actualHash, expectedHash)
    );
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePassword,
};
