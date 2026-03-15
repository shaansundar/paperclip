import argon2 from "argon2";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";

// Layout: [salt:16][nonce:12][authTag:16][ciphertext:N][hmac:32]
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const HMAC_SIZE = 32;

export const ENCRYPTED_HEADER_SIZE = SALT_SIZE + NONCE_SIZE;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  raw: true,
} as const;

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const hash = await argon2.hash(passphrase, {
    ...ARGON2_OPTIONS,
    salt,
  });
  // argon2 with raw:true returns a Buffer
  return hash as unknown as Buffer;
}

function computeHmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export async function encryptBuffer(
  plaintext: Buffer,
  passphrase: string
): Promise<Buffer> {
  const salt = randomBytes(SALT_SIZE);
  const nonce = randomBytes(NONCE_SIZE);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Compute HMAC over salt + nonce + authTag + ciphertext
  const payload = Buffer.concat([salt, nonce, authTag, ciphertext]);
  const hmac = computeHmac(salt, payload);

  return Buffer.concat([payload, hmac]);
}

export async function decryptBuffer(
  encrypted: Buffer,
  passphrase: string
): Promise<Buffer> {
  const minLength = SALT_SIZE + NONCE_SIZE + AUTH_TAG_SIZE + HMAC_SIZE;
  if (encrypted.length < minLength) {
    throw new Error("Encrypted buffer too short");
  }

  let offset = 0;
  const salt = encrypted.subarray(offset, (offset += SALT_SIZE));
  const nonce = encrypted.subarray(offset, (offset += NONCE_SIZE));
  const authTag = encrypted.subarray(offset, (offset += AUTH_TAG_SIZE));
  const ciphertext = encrypted.subarray(
    offset,
    encrypted.length - HMAC_SIZE
  );
  const hmac = encrypted.subarray(encrypted.length - HMAC_SIZE);

  // Verify HMAC integrity before attempting decryption
  const payload = encrypted.subarray(0, encrypted.length - HMAC_SIZE);
  const expectedHmac = computeHmac(salt, payload);
  if (!expectedHmac.equals(hmac)) {
    throw new Error("HMAC verification failed: data corrupted or tampered");
  }

  const key = await deriveKey(passphrase, salt);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Decryption failed: wrong passphrase or corrupted data");
  }
}

/**
 * Verifyintegrity checks the HMAC without decrypting.
 * Returns true if the archive is uncorrupted, false otherwise.
 */
export function verifyIntegrity(encrypted: Buffer): boolean {
  const minLength = SALT_SIZE + NONCE_SIZE + AUTH_TAG_SIZE + HMAC_SIZE;
  if (encrypted.length < minLength) {
    return false;
  }

  const salt = encrypted.subarray(0, SALT_SIZE);
  const payload = encrypted.subarray(0, encrypted.length - HMAC_SIZE);
  const hmac = encrypted.subarray(encrypted.length - HMAC_SIZE);
  const expectedHmac = computeHmac(salt, payload);

  return expectedHmac.equals(hmac);
}
