import { describe, expect, it } from "vitest";
import {
  encryptBuffer,
  decryptBuffer,
  verifyIntegrity,
  ENCRYPTED_HEADER_SIZE,
} from "../services/snapshot/encryption.js";

describe("snapshot encryption", () => {
  const passphrase = "test-passphrase-for-unit-tests";
  const plaintext = Buffer.from("Hello, Paperclip snapshot encryption!");

  it("encryptBuffer returns a Buffer larger than input with header", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    // Layout: [salt:16][nonce:12][authTag:16][ciphertext:N][hmac:32]
    const overhead = 16 + 12 + 16 + 32; // salt + nonce + authTag + hmac
    expect(encrypted.length).toBe(plaintext.length + overhead);
    expect(encrypted.length).toBeGreaterThan(plaintext.length);
    // ENCRYPTED_HEADER_SIZE should be salt + nonce
    expect(ENCRYPTED_HEADER_SIZE).toBe(16 + 12);
  });

  it("encryptBuffer produces different output for same input (random salt/nonce)", async () => {
    const enc1 = await encryptBuffer(plaintext, passphrase);
    const enc2 = await encryptBuffer(plaintext, passphrase);
    // Salt and nonce are random — ciphertexts must differ
    expect(enc1.equals(enc2)).toBe(false);
  });

  it("round-trip: encrypt then decrypt returns original plaintext", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    const decrypted = await decryptBuffer(encrypted, passphrase);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("decryptBuffer fails with wrong passphrase", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    await expect(
      decryptBuffer(encrypted, "wrong-passphrase")
    ).rejects.toThrow();
  });

  it("decryptBuffer fails with corrupted ciphertext", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    // Flip a byte in the ciphertext region (after salt+nonce+authTag)
    const corrupted = Buffer.from(encrypted);
    const corruptOffset = 16 + 12 + 16 + 1; // inside ciphertext
    corrupted[corruptOffset] = corrupted[corruptOffset] ^ 0xff;
    await expect(decryptBuffer(corrupted, passphrase)).rejects.toThrow();
  });

  it("verifyIntegrity returns true for uncorrupted archive", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    expect(verifyIntegrity(encrypted)).toBe(true);
  });

  it("verifyIntegrity returns false for corrupted archive", async () => {
    const encrypted = await encryptBuffer(plaintext, passphrase);
    const corrupted = Buffer.from(encrypted);
    // Corrupt a byte in the middle of ciphertext
    const mid = Math.floor(corrupted.length / 2);
    corrupted[mid] = corrupted[mid] ^ 0xaa;
    expect(verifyIntegrity(corrupted)).toBe(false);
  });

  it("handles 1MB buffer", async () => {
    const big = Buffer.alloc(1024 * 1024, 0x42);
    const encrypted = await encryptBuffer(big, passphrase);
    const decrypted = await decryptBuffer(encrypted, passphrase);
    expect(decrypted.equals(big)).toBe(true);
  }, 30000); // argon2id is intentionally slow — allow 30s
});
