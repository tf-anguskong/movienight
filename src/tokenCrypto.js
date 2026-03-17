/**
 * tokenCrypto.js — encrypt/decrypt Plex tokens stored in session files.
 *
 * Uses AES-256-GCM (authenticated encryption) keyed from SESSION_SECRET
 * via HKDF-SHA256. A random 12-byte IV is generated per encryption and
 * prepended to the ciphertext. The auth tag is appended.
 *
 * Format on disk (base64): <12-byte IV><ciphertext><16-byte GCM tag>
 */

const crypto = require('crypto');

// Derive a 32-byte key from SESSION_SECRET using HKDF
function deriveKey(secret) {
  return crypto.hkdfSync('sha256', secret, '', 'playdarr-token-encryption-v1', 32);
}

let _key = null;
function getKey() {
  if (!_key) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET not set');
    _key = Buffer.from(deriveKey(secret));
  }
  return _key;
}

function encryptToken(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

function decryptToken(ciphertext) {
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const enc = buf.subarray(12, buf.length - 16);
    const key = getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null; // tampered or invalid
  }
}

module.exports = { encryptToken, decryptToken };
