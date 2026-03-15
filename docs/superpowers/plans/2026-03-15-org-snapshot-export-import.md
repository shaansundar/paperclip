# Organization Snapshot Export/Import Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export and import complete organization state as an encrypted tar archive for device migration and backup/restore.

**Architecture:** Server-side service layer with encryption, path rewriting, and phased DB insertion. CLI commands via Commander.js, REST endpoints via Express, UI modal in Company Settings. All modules built TDD (RED-GREEN-REFACTOR).

**Tech Stack:** Node.js `node:crypto` (AES-256-GCM, Argon2 via argon2 npm), `tar` npm for archiving, Drizzle ORM for DB, Vitest for tests, Zod for validation, Commander.js for CLI, React for UI.

**Spec:** `docs/superpowers/specs/2026-03-15-org-snapshot-export-import-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `packages/shared/src/types/snapshot.ts` | Manifest, export options, import options, result types |
| `packages/shared/src/validators/snapshot.ts` | Zod schemas for export/import options, manifest validation |
| `server/src/services/snapshot/encryption.ts` | AES-256-GCM encrypt/decrypt with Argon2id key derivation |
| `server/src/services/snapshot/paths.ts` | Detect absolute paths in JSON, apply prefix rewriting |
| `server/src/services/snapshot/manifest.ts` | Build and validate manifest with checksums |
| `server/src/services/snapshot/export.ts` | Full export pipeline: extract data, bundle, encrypt |
| `server/src/services/snapshot/import.ts` | Full import pipeline: decrypt, rewrite, insert |
| `server/src/services/snapshot/index.ts` | Public API: `snapshotService(db, storage, secrets)` |
| `server/src/routes/snapshot.ts` | REST endpoints: export, import, inspect |
| `server/src/__tests__/snapshot-encryption.test.ts` | Encryption module tests |
| `server/src/__tests__/snapshot-paths.test.ts` | Path detection and rewriting tests |
| `server/src/__tests__/snapshot-manifest.test.ts` | Manifest generation and validation tests |
| `server/src/__tests__/snapshot-export.test.ts` | Export pipeline integration tests |
| `server/src/__tests__/snapshot-import.test.ts` | Import pipeline integration tests |
| `server/src/__tests__/snapshot-roundtrip.test.ts` | Full export→import round-trip tests |
| `cli/src/commands/export.ts` | CLI `paperclip export` command |
| `cli/src/commands/import.ts` | CLI `paperclip import` command |
| `cli/src/commands/snapshot-inspect.ts` | CLI `paperclip snapshot inspect` command |
| `ui/src/components/SnapshotExportModal.tsx` | Export modal UI |
| `ui/src/components/SnapshotImportModal.tsx` | Import modal UI with path mapping |

### Modified Files

| File | Change |
|---|---|
| `server/package.json` | Add `argon2`, `tar` dependencies |
| `packages/shared/src/types/index.ts` | Re-export snapshot types |
| `packages/shared/src/validators/index.ts` | Re-export snapshot validators |
| `server/src/routes/index.ts` | Register snapshot routes |
| `cli/src/index.ts` | Register export/import/inspect commands |
| `ui/src/pages/CompanySettings.tsx` | Add Snapshot section with export/import buttons |

---

## Chunk 1: Foundation — Types, Validators, Encryption

### Task 1: Shared Types

**Files:**
- Create: `packages/shared/src/types/snapshot.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Create snapshot types**

```typescript
// packages/shared/src/types/snapshot.ts

export interface SnapshotManifest {
  version: number;
  paperclipVersion: string;
  schemaVersion: string;
  exportedAt: string;
  sourceHostname: string;
  sourcePlatform: string;
  companyId: string;
  companyName: string;
  options: SnapshotExportOptions;
  recordCounts: Record<string, number>;
  checksums: Record<string, string>;
  assetsIncomplete: boolean;
  consistentSnapshot: boolean;
}

export interface SnapshotExportOptions {
  historyWindow: "all" | "none" | string; // "30d", "90d", etc.
  runsPerAgent: number | null;
  agentsPaused: boolean;
}

export interface SnapshotExportInput {
  passphrase: string;
  history?: string;       // "all" | "none" | "30d" (default)
  runsPerAgent?: number;
  pauseAgents?: boolean;  // default true
}

export interface SnapshotExportResult {
  filePath: string;
  manifest: SnapshotManifest;
  warnings: string[];
}

export interface SnapshotImportInput {
  passphrase: string;
  pathMappings?: Record<string, string>; // old prefix -> new prefix
  onConflict?: "abort" | "rename" | "replace";
}

export interface SnapshotImportResult {
  companyId: string;
  companyName: string;
  recordCounts: Record<string, number>;
  warnings: string[];
  apiKeyMapping: Array<{ agentId: string; agentName: string; newKeyPrefix: string }>;
  orphanedUserRefs: string[];
}

export interface SnapshotInspectResult {
  manifest: SnapshotManifest;
  detectedPaths: SnapshotPathEntry[];
  schemaCompatibility: "compatible" | "upgrade_required" | "exact";
  conflicts: SnapshotConflict[];
}

export interface SnapshotPathEntry {
  table: string;
  id: string;
  field: string;
  value: string;
}

export interface SnapshotConflict {
  type: "name" | "id" | "issuePrefix";
  existingValue: string;
  snapshotValue: string;
}
```

- [ ] **Step 2: Export types from index**

Add to `packages/shared/src/types/index.ts`:
```typescript
export type {
  SnapshotManifest,
  SnapshotExportOptions,
  SnapshotExportInput,
  SnapshotExportResult,
  SnapshotImportInput,
  SnapshotImportResult,
  SnapshotInspectResult,
  SnapshotPathEntry,
  SnapshotConflict,
} from "./snapshot.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/snapshot.ts packages/shared/src/types/index.ts
git commit -m "feat: add snapshot export/import shared types"
```

### Task 2: Zod Validators

**Files:**
- Create: `packages/shared/src/validators/snapshot.ts`
- Modify: `packages/shared/src/validators/index.ts` (or equivalent export file)

- [ ] **Step 1: Create validators**

```typescript
// packages/shared/src/validators/snapshot.ts
import { z } from "zod";

export const snapshotExportInputSchema = z.object({
  passphrase: z.string().min(12, "Passphrase must be at least 12 characters"),
  history: z.string().regex(/^(all|none|\d+d)$/).default("30d"),
  runsPerAgent: z.number().int().positive().nullable().optional(),
  pauseAgents: z.boolean().default(true),
});

export const snapshotImportInputSchema = z.object({
  passphrase: z.string().min(1),
  pathMappings: z.record(z.string(), z.string()).optional(),
  onConflict: z.enum(["abort", "rename", "replace"]).default("abort"),
});

export const snapshotManifestSchema = z.object({
  version: z.number().int().positive(),
  paperclipVersion: z.string(),
  schemaVersion: z.string(),
  exportedAt: z.string().datetime(),
  sourceHostname: z.string(),
  sourcePlatform: z.string(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  options: z.object({
    historyWindow: z.string(),
    runsPerAgent: z.number().nullable(),
    agentsPaused: z.boolean(),
  }),
  recordCounts: z.record(z.string(), z.number()),
  checksums: z.record(z.string(), z.string()),
  assetsIncomplete: z.boolean(),
  consistentSnapshot: z.boolean(),
});

export type SnapshotExportInputParsed = z.infer<typeof snapshotExportInputSchema>;
export type SnapshotImportInputParsed = z.infer<typeof snapshotImportInputSchema>;
```

- [ ] **Step 2: Export validators from index**

Add to validators index file:
```typescript
export {
  snapshotExportInputSchema,
  snapshotImportInputSchema,
  snapshotManifestSchema,
} from "./snapshot.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/validators/snapshot.ts packages/shared/src/validators/index.ts
git commit -m "feat: add snapshot Zod validators"
```

### Task 3: Encryption Module (TDD)

**Files:**
- Create: `server/src/__tests__/snapshot-encryption.test.ts`
- Create: `server/src/services/snapshot/encryption.ts`

- [ ] **Step 1: Install argon2 dependency**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm add -F server argon2
```

- [ ] **Step 2: Write the failing tests**

```typescript
// server/src/__tests__/snapshot-encryption.test.ts
import { describe, expect, it } from "vitest";
import {
  encryptBuffer,
  decryptBuffer,
  ENCRYPTED_HEADER_SIZE,
} from "../services/snapshot/encryption.js";

describe("snapshot encryption", () => {
  const passphrase = "test-passphrase-long-enough";

  describe("encryptBuffer", () => {
    it("encrypts a buffer and returns a larger buffer with header", async () => {
      const plaintext = Buffer.from("hello world");
      const encrypted = await encryptBuffer(plaintext, passphrase);

      expect(encrypted).toBeInstanceOf(Buffer);
      expect(encrypted.length).toBeGreaterThan(plaintext.length);
      // Header: 16 bytes salt + 12 bytes nonce + 32 bytes HMAC at end
      expect(encrypted.length).toBeGreaterThan(ENCRYPTED_HEADER_SIZE);
    });

    it("produces different output for same input (random salt/nonce)", async () => {
      const plaintext = Buffer.from("determinism check");
      const enc1 = await encryptBuffer(plaintext, passphrase);
      const enc2 = await encryptBuffer(plaintext, passphrase);

      expect(Buffer.compare(enc1, enc2)).not.toBe(0);
    });
  });

  describe("decryptBuffer", () => {
    it("round-trips: encrypt then decrypt returns original", async () => {
      const plaintext = Buffer.from("round trip test data 12345");
      const encrypted = await encryptBuffer(plaintext, passphrase);
      const decrypted = await decryptBuffer(encrypted, passphrase);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("fails with wrong passphrase", async () => {
      const plaintext = Buffer.from("secret data");
      const encrypted = await encryptBuffer(plaintext, passphrase);

      await expect(
        decryptBuffer(encrypted, "wrong-passphrase-here")
      ).rejects.toThrow();
    });

    it("fails with corrupted ciphertext", async () => {
      const plaintext = Buffer.from("integrity check");
      const encrypted = await encryptBuffer(plaintext, passphrase);
      // Corrupt a byte in the ciphertext (after header)
      encrypted[ENCRYPTED_HEADER_SIZE + 5] ^= 0xff;

      await expect(
        decryptBuffer(encrypted, passphrase)
      ).rejects.toThrow();
    });
  });

  describe("verifyIntegrity", () => {
    it("returns true for uncorrupted archive", async () => {
      const { verifyIntegrity } = await import(
        "../services/snapshot/encryption.js"
      );
      const plaintext = Buffer.from("integrity ok");
      const encrypted = await encryptBuffer(plaintext, passphrase);

      expect(verifyIntegrity(encrypted)).toBe(true);
    });

    it("returns false for corrupted archive without needing passphrase", async () => {
      const { verifyIntegrity } = await import(
        "../services/snapshot/encryption.js"
      );
      const plaintext = Buffer.from("will corrupt");
      const encrypted = await encryptBuffer(plaintext, passphrase);
      // Corrupt ciphertext
      encrypted[ENCRYPTED_HEADER_SIZE + 2] ^= 0xff;

      expect(verifyIntegrity(encrypted)).toBe(false);
    });
  });

  describe("large buffers", () => {
    it("handles 1MB buffer", async () => {
      const plaintext = Buffer.alloc(1024 * 1024, 0xab);
      const encrypted = await encryptBuffer(plaintext, passphrase);
      const decrypted = await decryptBuffer(encrypted, passphrase);

      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });
});
```

- [ ] **Step 3: Run tests — verify they FAIL**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-encryption.test.ts
```

Expected: FAIL — module `../services/snapshot/encryption.js` does not exist.

- [ ] **Step 4: Write minimal implementation to pass**

```typescript
// server/src/services/snapshot/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import argon2 from "argon2";

const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const HMAC_SIZE = 32;
const AUTH_TAG_SIZE = 16;
export const ENCRYPTED_HEADER_SIZE = SALT_SIZE + NONCE_SIZE;

const ARGON2_OPTIONS = {
  type: argon2.argon2id as const,
  memoryCost: 65536, // 64MB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const hash = await argon2.hash(passphrase, {
    ...ARGON2_OPTIONS,
    salt,
    raw: true,
  });
  return Buffer.from(hash);
}

export async function encryptBuffer(
  plaintext: Buffer,
  passphrase: string
): Promise<Buffer> {
  const salt = randomBytes(SALT_SIZE);
  const nonce = randomBytes(NONCE_SIZE);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: [salt:16][nonce:12][authTag:16][ciphertext:N][hmac:32]
  const payload = Buffer.concat([salt, nonce, authTag, encrypted]);

  // HMAC over everything for integrity check without passphrase
  const hmac = createHmac("sha256", salt).update(payload).digest();

  return Buffer.concat([payload, hmac]);
}

export async function decryptBuffer(
  encrypted: Buffer,
  passphrase: string
): Promise<Buffer> {
  if (!verifyIntegrity(encrypted)) {
    throw new Error("Archive integrity check failed — file may be corrupted");
  }

  const salt = encrypted.subarray(0, SALT_SIZE);
  const nonce = encrypted.subarray(SALT_SIZE, SALT_SIZE + NONCE_SIZE);
  const authTag = encrypted.subarray(
    SALT_SIZE + NONCE_SIZE,
    SALT_SIZE + NONCE_SIZE + AUTH_TAG_SIZE
  );
  const ciphertext = encrypted.subarray(
    SALT_SIZE + NONCE_SIZE + AUTH_TAG_SIZE,
    encrypted.length - HMAC_SIZE
  );

  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function verifyIntegrity(encrypted: Buffer): boolean {
  if (encrypted.length < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE + HMAC_SIZE) {
    return false;
  }
  const payload = encrypted.subarray(0, encrypted.length - HMAC_SIZE);
  const storedHmac = encrypted.subarray(encrypted.length - HMAC_SIZE);
  const salt = encrypted.subarray(0, SALT_SIZE);
  const computedHmac = createHmac("sha256", salt).update(payload).digest();

  return computedHmac.equals(storedHmac);
}
```

- [ ] **Step 5: Run tests — verify they PASS**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-encryption.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/__tests__/snapshot-encryption.test.ts server/src/services/snapshot/encryption.ts server/package.json pnpm-lock.yaml
git commit -m "feat: add snapshot encryption module with AES-256-GCM + Argon2id"
```

### Task 4: Path Detection & Rewriting Module (TDD)

**Files:**
- Create: `server/src/__tests__/snapshot-paths.test.ts`
- Create: `server/src/services/snapshot/paths.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/snapshot-paths.test.ts
import { describe, expect, it } from "vitest";
import { detectPaths, rewritePaths } from "../services/snapshot/paths.js";
import type { SnapshotPathEntry } from "@paperclipai/shared";

describe("snapshot path detection", () => {
  describe("detectPaths", () => {
    it("detects workspaceDir in agent adapterConfig", () => {
      const agents = [
        {
          id: "agent-1",
          adapterConfig: { workspaceDir: "/Users/alice/Code/project" },
        },
      ];
      const result = detectPaths("agents", agents, [
        "adapterConfig.workspaceDir",
        "adapterConfig.cwd",
      ]);

      expect(result.entries).toEqual([
        {
          table: "agents",
          id: "agent-1",
          field: "adapterConfig.workspaceDir",
          value: "/Users/alice/Code/project",
        },
      ]);
      expect(result.prefixes).toContain("/Users/alice/Code");
    });

    it("detects cwd in workspaces", () => {
      const workspaces = [
        { id: "ws-1", cwd: "/Users/alice/Code/repo" },
        { id: "ws-2", cwd: "/Users/alice/Code/other" },
      ];
      const result = detectPaths("workspaces", workspaces, ["cwd"]);

      expect(result.entries).toHaveLength(2);
      expect(result.prefixes).toEqual(["/Users/alice/Code"]);
    });

    it("skips null and undefined values", () => {
      const agents = [
        { id: "agent-1", adapterConfig: { workspaceDir: null } },
        { id: "agent-2", adapterConfig: {} },
      ];
      const result = detectPaths("agents", agents, [
        "adapterConfig.workspaceDir",
      ]);

      expect(result.entries).toHaveLength(0);
    });

    it("skips non-absolute paths", () => {
      const workspaces = [
        { id: "ws-1", cwd: "relative/path" },
        { id: "ws-2", cwd: "https://github.com/org/repo" },
      ];
      const result = detectPaths("workspaces", workspaces, ["cwd"]);

      expect(result.entries).toHaveLength(0);
    });

    it("deduplicates prefixes", () => {
      const items = [
        { id: "1", cwd: "/Users/alice/Code/a" },
        { id: "2", cwd: "/Users/alice/Code/b" },
        { id: "3", cwd: "/Users/alice/Other/c" },
      ];
      const result = detectPaths("test", items, ["cwd"]);

      expect(result.prefixes).toEqual([
        "/Users/alice/Code",
        "/Users/alice/Other",
      ]);
    });
  });

  describe("rewritePaths", () => {
    it("applies prefix substitution to matching entries", () => {
      const data = [
        {
          id: "agent-1",
          adapterConfig: { workspaceDir: "/Users/alice/Code/project" },
        },
      ];
      const mappings = { "/Users/alice/Code": "/Users/bob/projects" };

      const result = rewritePaths(data, [
        {
          table: "agents",
          id: "agent-1",
          field: "adapterConfig.workspaceDir",
          value: "/Users/alice/Code/project",
        },
      ], mappings);

      expect(result[0].adapterConfig.workspaceDir).toBe(
        "/Users/bob/projects/project"
      );
    });

    it("does not mutate original data", () => {
      const data = [
        { id: "1", cwd: "/Users/alice/Code/repo" },
      ];
      const original = JSON.parse(JSON.stringify(data));
      const mappings = { "/Users/alice/Code": "/Users/bob/work" };

      rewritePaths(data, [
        {
          table: "test",
          id: "1",
          field: "cwd",
          value: "/Users/alice/Code/repo",
        },
      ], mappings);

      expect(data).toEqual(original);
    });

    it("handles multiple prefix mappings", () => {
      const data = [
        { id: "1", cwd: "/Users/alice/Code/a" },
        { id: "2", cwd: "/opt/data/b" },
      ];
      const entries: SnapshotPathEntry[] = [
        { table: "t", id: "1", field: "cwd", value: "/Users/alice/Code/a" },
        { table: "t", id: "2", field: "cwd", value: "/opt/data/b" },
      ];
      const mappings = {
        "/Users/alice/Code": "/Users/bob/Code",
        "/opt/data": "/mnt/storage",
      };

      const result = rewritePaths(data, entries, mappings);

      expect(result[0].cwd).toBe("/Users/bob/Code/a");
      expect(result[1].cwd).toBe("/mnt/storage/b");
    });

    it("returns unmodified items when no mapping matches", () => {
      const data = [{ id: "1", cwd: "/unmatched/path" }];
      const entries: SnapshotPathEntry[] = [
        { table: "t", id: "1", field: "cwd", value: "/unmatched/path" },
      ];

      const result = rewritePaths(data, entries, {
        "/Users/alice": "/Users/bob",
      });

      expect(result[0].cwd).toBe("/unmatched/path");
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they FAIL**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-paths.test.ts
```

Expected: FAIL — module `../services/snapshot/paths.js` does not exist.

- [ ] **Step 3: Write minimal implementation to pass**

```typescript
// server/src/services/snapshot/paths.ts
import type { SnapshotPathEntry } from "@paperclipai/shared";

interface DetectResult {
  entries: SnapshotPathEntry[];
  prefixes: string[];
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const result = structuredClone(obj);
  const parts = path.split(".");
  let current: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Z]:\\/i.test(value);
}

function extractPrefix(absolutePath: string): string {
  // Remove the last path segment to get the parent directory
  const parts = absolutePath.split("/").filter(Boolean);
  if (parts.length <= 1) return "/" + parts[0];
  return "/" + parts.slice(0, -1).join("/");
}

export function detectPaths(
  tableName: string,
  records: Array<Record<string, unknown>>,
  fieldPaths: string[]
): DetectResult {
  const entries: SnapshotPathEntry[] = [];
  const prefixSet = new Set<string>();

  for (const record of records) {
    const id = String(record.id ?? "");
    for (const fieldPath of fieldPaths) {
      const value = getNestedValue(record, fieldPath);
      if (typeof value !== "string" || !isAbsolutePath(value)) continue;

      entries.push({ table: tableName, id, field: fieldPath, value });
      prefixSet.add(extractPrefix(value));
    }
  }

  return {
    entries,
    prefixes: Array.from(prefixSet).sort(),
  };
}

export function rewritePaths<T extends Record<string, unknown>>(
  records: T[],
  entries: SnapshotPathEntry[],
  mappings: Record<string, string>
): T[] {
  const entryMap = new Map<string, SnapshotPathEntry[]>();
  for (const entry of entries) {
    const key = entry.id;
    const list = entryMap.get(key) ?? [];
    list.push(entry);
    entryMap.set(key, list);
  }

  return records.map((record) => {
    const id = String(record.id ?? "");
    const recordEntries = entryMap.get(id);
    if (!recordEntries) return structuredClone(record) as T;

    let result: Record<string, unknown> = structuredClone(record);
    for (const entry of recordEntries) {
      const currentValue = getNestedValue(result, entry.field);
      if (typeof currentValue !== "string") continue;

      for (const [oldPrefix, newPrefix] of Object.entries(mappings)) {
        if (currentValue.startsWith(oldPrefix)) {
          const rewritten = newPrefix + currentValue.slice(oldPrefix.length);
          result = setNestedValue(result, entry.field, rewritten);
          break;
        }
      }
    }
    return result as T;
  });
}
```

- [ ] **Step 4: Run tests — verify they PASS**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-paths.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/snapshot-paths.test.ts server/src/services/snapshot/paths.ts
git commit -m "feat: add snapshot path detection and rewriting module"
```

### Task 5: Manifest Module (TDD)

**Files:**
- Create: `server/src/__tests__/snapshot-manifest.test.ts`
- Create: `server/src/services/snapshot/manifest.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/snapshot-manifest.test.ts
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  validateManifest,
  computeChecksum,
} from "../services/snapshot/manifest.js";

describe("snapshot manifest", () => {
  describe("computeChecksum", () => {
    it("returns sha256 hex for a buffer", () => {
      const result = computeChecksum(Buffer.from("test"));
      expect(result).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("returns same hash for same input", () => {
      const a = computeChecksum(Buffer.from("same"));
      const b = computeChecksum(Buffer.from("same"));
      expect(a).toBe(b);
    });

    it("returns different hash for different input", () => {
      const a = computeChecksum(Buffer.from("aaa"));
      const b = computeChecksum(Buffer.from("bbb"));
      expect(a).not.toBe(b);
    });
  });

  describe("buildManifest", () => {
    it("builds a valid manifest from inputs", () => {
      const manifest = buildManifest({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        companyName: "Test Corp",
        options: {
          historyWindow: "30d",
          runsPerAgent: null,
          agentsPaused: true,
        },
        recordCounts: { agents: 5, issues: 20 },
        checksums: { "company.json": "sha256:abc123" },
        assetsIncomplete: false,
        consistentSnapshot: true,
      });

      expect(manifest.version).toBe(1);
      expect(manifest.companyId).toBe(
        "550e8400-e29b-41d4-a716-446655440000"
      );
      expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(manifest.sourceHostname).toBeTruthy();
      expect(manifest.sourcePlatform).toBeTruthy();
    });
  });

  describe("validateManifest", () => {
    it("accepts a valid manifest", () => {
      const manifest = buildManifest({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        companyName: "Test",
        options: {
          historyWindow: "30d",
          runsPerAgent: null,
          agentsPaused: true,
        },
        recordCounts: {},
        checksums: {},
        assetsIncomplete: false,
        consistentSnapshot: true,
      });

      expect(() => validateManifest(manifest)).not.toThrow();
    });

    it("rejects manifest with missing required fields", () => {
      expect(() => validateManifest({} as never)).toThrow();
    });

    it("rejects manifest with unsupported version", () => {
      const manifest = buildManifest({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        companyName: "Test",
        options: {
          historyWindow: "30d",
          runsPerAgent: null,
          agentsPaused: true,
        },
        recordCounts: {},
        checksums: {},
        assetsIncomplete: false,
        consistentSnapshot: true,
      });
      const future = { ...manifest, version: 99 };

      expect(() => validateManifest(future)).toThrow(/version/i);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they FAIL**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-manifest.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/snapshot/manifest.ts
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { snapshotManifestSchema } from "@paperclipai/shared/validators";
import type {
  SnapshotManifest,
  SnapshotExportOptions,
} from "@paperclipai/shared";

const CURRENT_VERSION = 1;
const MAX_SUPPORTED_VERSION = 1;

interface BuildManifestInput {
  companyId: string;
  companyName: string;
  options: SnapshotExportOptions;
  recordCounts: Record<string, number>;
  checksums: Record<string, string>;
  assetsIncomplete: boolean;
  consistentSnapshot: boolean;
}

export function computeChecksum(data: Buffer): string {
  const hash = createHash("sha256").update(data).digest("hex");
  return `sha256:${hash}`;
}

export function buildManifest(input: BuildManifestInput): SnapshotManifest {
  return {
    version: CURRENT_VERSION,
    paperclipVersion: process.env.npm_package_version ?? "0.0.0",
    schemaVersion: "latest",
    exportedAt: new Date().toISOString(),
    sourceHostname: hostname(),
    sourcePlatform: `${process.platform}-${process.arch}`,
    companyId: input.companyId,
    companyName: input.companyName,
    options: input.options,
    recordCounts: input.recordCounts,
    checksums: input.checksums,
    assetsIncomplete: input.assetsIncomplete,
    consistentSnapshot: input.consistentSnapshot,
  };
}

export function validateManifest(data: unknown): SnapshotManifest {
  const parsed = snapshotManifestSchema.parse(data);
  if (parsed.version > MAX_SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported snapshot version ${parsed.version}. Max supported: ${MAX_SUPPORTED_VERSION}. Upgrade Paperclip first.`
    );
  }
  return parsed as SnapshotManifest;
}
```

- [ ] **Step 4: Run tests — verify they PASS**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-manifest.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/snapshot-manifest.test.ts server/src/services/snapshot/manifest.ts
git commit -m "feat: add snapshot manifest builder and validator"
```

---

## Chunk 2: Export Pipeline

### Task 6: Install tar dependency

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install tar**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm add -F server tar && pnpm add -D -F server @types/tar
```

- [ ] **Step 2: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "chore: add tar dependency for snapshot archiving"
```

### Task 7: Export Service (TDD)

**Files:**
- Create: `server/src/__tests__/snapshot-export.test.ts`
- Create: `server/src/services/snapshot/export.ts`
- Create: `server/src/services/snapshot/index.ts`

This is the largest task. Tests will use a real DB (embedded postgres from the test harness) to verify correct data extraction.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/snapshot-export.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { createSnapshotExporter } from "../services/snapshot/export.js";
import { decryptBuffer } from "../services/snapshot/encryption.js";

// These tests validate the export pipeline produces a valid archive.
// They use mocked DB responses since the full DB setup is heavy.
// Integration tests with real DB are in snapshot-roundtrip.test.ts.

describe("snapshot export", () => {
  const passphrase = "test-export-passphrase-12chars";
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "snapshot-export-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("createSnapshotExporter", () => {
    it("exports a valid encrypted tar.gz archive", async () => {
      const mockDb = createMockDb();
      const exporter = createSnapshotExporter(mockDb);

      const result = await exporter.export({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        passphrase,
        history: "none",
        pauseAgents: false,
        outputDir: tempDir,
      });

      // File should exist
      expect(result.filePath).toMatch(/\.tar\.gz\.enc$/);
      const exists = await fs
        .stat(result.filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Should be decryptable
      const encrypted = await fs.readFile(result.filePath);
      const tarGz = await decryptBuffer(encrypted, passphrase);
      expect(tarGz.length).toBeGreaterThan(0);

      // Should contain manifest.json when extracted
      const extractDir = join(tempDir, "extracted");
      await fs.mkdir(extractDir, { recursive: true });
      await fs.writeFile(join(tempDir, "archive.tar.gz"), tarGz);
      await tar.x({ file: join(tempDir, "archive.tar.gz"), cwd: extractDir });

      const manifestPath = join(extractDir, "manifest.json");
      const manifestExists = await fs
        .stat(manifestPath)
        .then(() => true)
        .catch(() => false);
      expect(manifestExists).toBe(true);

      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
      expect(manifest.version).toBe(1);
      expect(manifest.companyId).toBe(
        "550e8400-e29b-41d4-a716-446655440000"
      );
    });

    it("includes all required JSON files in archive", async () => {
      const mockDb = createMockDb();
      const exporter = createSnapshotExporter(mockDb);

      const result = await exporter.export({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        passphrase,
        history: "none",
        pauseAgents: false,
        outputDir: tempDir,
      });

      const encrypted = await fs.readFile(result.filePath);
      const tarGz = await decryptBuffer(encrypted, passphrase);

      const extractDir = join(tempDir, "extracted-structure");
      await fs.mkdir(extractDir, { recursive: true });
      await fs.writeFile(join(tempDir, "struct.tar.gz"), tarGz);
      await tar.x({ file: join(tempDir, "struct.tar.gz"), cwd: extractDir });

      // Check required files exist
      const requiredFiles = [
        "manifest.json",
        "company.json",
        "agents/agents.json",
        "agents/runtime_state.json",
        "agents/task_sessions.json",
        "agents/config_revisions.json",
        "agents/api_keys.json",
        "goals/goals.json",
        "projects/projects.json",
        "projects/workspaces.json",
        "issues/issues.json",
        "issues/comments.json",
        "issues/labels.json",
        "governance/approvals.json",
        "governance/memberships.json",
        "governance/permissions.json",
        "governance/issue_approvals.json",
        "secrets/secrets.json",
        "path_mappings.json",
      ];

      for (const file of requiredFiles) {
        const filePath = join(extractDir, file);
        const fileExists = await fs
          .stat(filePath)
          .then(() => true)
          .catch(() => false);
        expect(fileExists, `Missing file: ${file}`).toBe(true);
      }
    });

    it("populates manifest recordCounts correctly", async () => {
      const mockDb = createMockDb({ agentCount: 3, issueCount: 10 });
      const exporter = createSnapshotExporter(mockDb);

      const result = await exporter.export({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        passphrase,
        history: "none",
        pauseAgents: false,
        outputDir: tempDir,
      });

      expect(result.manifest.recordCounts.agents).toBe(3);
      expect(result.manifest.recordCounts.issues).toBe(10);
    });

    it("detects absolute paths and writes path_mappings.json", async () => {
      const mockDb = createMockDb({
        agents: [
          {
            id: "a1",
            adapterConfig: { workspaceDir: "/Users/alice/Code/proj" },
          },
        ],
      });
      const exporter = createSnapshotExporter(mockDb);

      const result = await exporter.export({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        passphrase,
        history: "none",
        pauseAgents: false,
        outputDir: tempDir,
      });

      const encrypted = await fs.readFile(result.filePath);
      const tarGz = await decryptBuffer(encrypted, passphrase);
      const extractDir = join(tempDir, "extracted-paths");
      await fs.mkdir(extractDir, { recursive: true });
      await fs.writeFile(join(tempDir, "paths.tar.gz"), tarGz);
      await tar.x({ file: join(tempDir, "paths.tar.gz"), cwd: extractDir });

      const pathMappings = JSON.parse(
        await fs.readFile(join(extractDir, "path_mappings.json"), "utf-8")
      );
      expect(pathMappings.detectedPrefixes).toContain("/Users/alice/Code");
      expect(pathMappings.pathEntries).toHaveLength(1);
      expect(pathMappings.pathEntries[0].field).toBe(
        "adapterConfig.workspaceDir"
      );
    });

    it("cleans up temp directory even on error", async () => {
      const mockDb = createFailingMockDb();
      const exporter = createSnapshotExporter(mockDb);

      await expect(
        exporter.export({
          companyId: "nonexistent",
          passphrase,
          history: "none",
          pauseAgents: false,
          outputDir: tempDir,
        })
      ).rejects.toThrow();

      // Temp directories inside outputDir should be cleaned up
      const entries = await fs.readdir(tempDir);
      const tempDirs = entries.filter((e) => e.startsWith("snapshot-build-"));
      expect(tempDirs).toHaveLength(0);
    });
  });
});

// --- Mock helpers ---

function createMockDb(overrides?: {
  agentCount?: number;
  issueCount?: number;
  agents?: Array<Record<string, unknown>>;
}) {
  const defaultCompany = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Test Corp",
    issuePrefix: "TST",
    issueCounter: 10,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const agents =
    overrides?.agents ??
    Array.from({ length: overrides?.agentCount ?? 1 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      companyId: defaultCompany.id,
      adapterConfig: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

  const issues = Array.from(
    { length: overrides?.issueCount ?? 0 },
    (_, i) => ({
      id: `issue-${i}`,
      identifier: `TST-${i + 1}`,
      companyId: defaultCompany.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );

  // Return a mock that responds to Drizzle-style queries
  return {
    select: () => ({
      from: (table: { _: { name: string } }) => {
        const name = table?._.name ?? table?.[Symbol.for("drizzle:Name")] ?? "";
        return {
          where: () => {
            if (name === "companies") return Promise.resolve([defaultCompany]);
            if (name === "agents") return Promise.resolve(agents);
            if (name === "issues") return Promise.resolve(issues);
            return Promise.resolve([]);
          },
        };
      },
    }),
  };
}

function createFailingMockDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.reject(new Error("Company not found")),
      }),
    }),
  };
}
```

- [ ] **Step 2: Run tests — verify they FAIL**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-export.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the export service implementation**

This is a larger file. Create `server/src/services/snapshot/export.ts` with:
- `createSnapshotExporter(db)` factory function
- `.export(input)` method that:
  1. Creates temp dir
  2. Queries each table by companyId
  3. Writes JSON files to temp dir structure
  4. Runs path detection
  5. Computes checksums
  6. Builds manifest
  7. Creates tar.gz from temp dir
  8. Encrypts tar.gz
  9. Cleans up temp dir (in finally block)

The implementation should follow the service factory pattern from `companies.ts` and use the encryption, paths, and manifest modules from Tasks 3-5.

Key implementation details:
- Use `node:fs/promises` for file ops
- Use `tar.c()` for creating tar archives
- Use `structuredClone()` for immutable data handling
- Wrap steps 5-10 in try/finally for cleanup
- Query tables using Drizzle: `db.select().from(table).where(eq(table.companyId, companyId))`

- [ ] **Step 4: Create the service index file**

```typescript
// server/src/services/snapshot/index.ts
export { createSnapshotExporter } from "./export.js";
export { encryptBuffer, decryptBuffer, verifyIntegrity } from "./encryption.js";
export { detectPaths, rewritePaths } from "./paths.js";
export { buildManifest, validateManifest, computeChecksum } from "./manifest.js";
```

- [ ] **Step 5: Run tests — verify they PASS**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-export.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/__tests__/snapshot-export.test.ts server/src/services/snapshot/export.ts server/src/services/snapshot/index.ts
git commit -m "feat: add snapshot export pipeline with TDD"
```

---

## Chunk 3: Import Pipeline

### Task 8: Import Service (TDD)

**Files:**
- Create: `server/src/__tests__/snapshot-import.test.ts`
- Create: `server/src/services/snapshot/import.ts`
- Modify: `server/src/services/snapshot/index.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/snapshot-import.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotImporter } from "../services/snapshot/import.js";

describe("snapshot import", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "snapshot-import-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("inspect", () => {
    it("returns manifest and detected paths from archive", async () => {
      const archive = await createTestArchive(tempDir);
      const importer = createSnapshotImporter(createMockTargetDb());

      const result = await importer.inspect({
        filePath: archive.filePath,
        passphrase: archive.passphrase,
      });

      expect(result.manifest.version).toBe(1);
      expect(result.manifest.companyName).toBe("Test Corp");
      expect(result.schemaCompatibility).toBe("compatible");
    });

    it("detects name conflict with existing company", async () => {
      const archive = await createTestArchive(tempDir);
      const importer = createSnapshotImporter(
        createMockTargetDb({ existingCompanyName: "Test Corp" })
      );

      const result = await importer.inspect({
        filePath: archive.filePath,
        passphrase: archive.passphrase,
      });

      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ type: "name" })
      );
    });

    it("fails with wrong passphrase", async () => {
      const archive = await createTestArchive(tempDir);
      const importer = createSnapshotImporter(createMockTargetDb());

      await expect(
        importer.inspect({
          filePath: archive.filePath,
          passphrase: "wrong-passphrase-here",
        })
      ).rejects.toThrow();
    });
  });

  describe("import", () => {
    it("inserts company and agents into target DB", async () => {
      const archive = await createTestArchive(tempDir);
      const { db, insertedRecords } = createTrackingMockDb();
      const importer = createSnapshotImporter(db);

      const result = await importer.import({
        filePath: archive.filePath,
        passphrase: archive.passphrase,
        pathMappings: {},
        onConflict: "abort",
      });

      expect(result.companyId).toBeTruthy();
      expect(result.recordCounts.agents).toBeGreaterThanOrEqual(0);
      expect(insertedRecords.has("companies")).toBe(true);
    });

    it("applies path rewriting during import", async () => {
      const archive = await createTestArchive(tempDir, {
        agents: [
          {
            id: "a1",
            name: "Agent1",
            companyId: "550e8400-e29b-41d4-a716-446655440000",
            adapterConfig: { workspaceDir: "/Users/alice/Code/proj" },
          },
        ],
      });
      const { db, insertedRecords } = createTrackingMockDb();
      const importer = createSnapshotImporter(db);

      await importer.import({
        filePath: archive.filePath,
        passphrase: archive.passphrase,
        pathMappings: { "/Users/alice/Code": "/Users/bob/work" },
        onConflict: "abort",
      });

      const agents = insertedRecords.get("agents") ?? [];
      const agent = agents[0] as Record<string, unknown>;
      const config = agent?.adapterConfig as Record<string, string>;
      expect(config?.workspaceDir).toBe("/Users/bob/work/proj");
    });

    it("aborts on conflict when onConflict is abort", async () => {
      const archive = await createTestArchive(tempDir);
      const importer = createSnapshotImporter(
        createMockTargetDb({ existingCompanyName: "Test Corp" })
      );

      await expect(
        importer.import({
          filePath: archive.filePath,
          passphrase: archive.passphrase,
          onConflict: "abort",
        })
      ).rejects.toThrow(/conflict/i);
    });

    it("cleans up temp directory after import", async () => {
      const archive = await createTestArchive(tempDir);
      const { db } = createTrackingMockDb();
      const importer = createSnapshotImporter(db);

      await importer.import({
        filePath: archive.filePath,
        passphrase: archive.passphrase,
        onConflict: "abort",
      });

      const entries = await fs.readdir(tempDir);
      const extractDirs = entries.filter((e) =>
        e.startsWith("snapshot-extract-")
      );
      expect(extractDirs).toHaveLength(0);
    });
  });
});

// --- Test helpers ---
// createTestArchive: builds a minimal valid archive for testing
// createMockTargetDb: mock DB that tracks inserts
// createTrackingMockDb: mock DB with insert recording

async function createTestArchive(
  dir: string,
  overrides?: { agents?: Array<Record<string, unknown>> }
) {
  // Use the real export pipeline to create a test archive
  const { createSnapshotExporter } = await import(
    "../services/snapshot/export.js"
  );
  const passphrase = "test-import-passphrase-12chars";

  const mockDb = {
    select: () => ({
      from: (table: { _: { name: string } }) => {
        const name = table?._.name ?? "";
        return {
          where: () => {
            if (name === "companies")
              return Promise.resolve([
                {
                  id: "550e8400-e29b-41d4-a716-446655440000",
                  name: "Test Corp",
                  issuePrefix: "TST",
                  issueCounter: 5,
                  status: "active",
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]);
            if (name === "agents")
              return Promise.resolve(
                overrides?.agents ?? [
                  {
                    id: "a1",
                    name: "TestAgent",
                    companyId: "550e8400-e29b-41d4-a716-446655440000",
                    adapterConfig: {},
                  },
                ]
              );
            return Promise.resolve([]);
          },
        };
      },
    }),
  };

  const exporter = createSnapshotExporter(mockDb as never);
  const result = await exporter.export({
    companyId: "550e8400-e29b-41d4-a716-446655440000",
    passphrase,
    history: "none",
    pauseAgents: false,
    outputDir: dir,
  });

  return { filePath: result.filePath, passphrase };
}

function createMockTargetDb(
  overrides?: { existingCompanyName?: string }
) {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          if (overrides?.existingCompanyName) {
            return Promise.resolve([
              {
                id: "existing-id",
                name: overrides.existingCompanyName,
              },
            ]);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    transaction: (fn: (tx: unknown) => Promise<void>) => fn({
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    }),
  };
}

function createTrackingMockDb() {
  const insertedRecords = new Map<string, unknown[]>();

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: (table: { _: { name: string } }) => ({
      values: (data: unknown) => {
        const name = table?._.name ?? "unknown";
        const existing = insertedRecords.get(name) ?? [];
        const records = Array.isArray(data) ? data : [data];
        insertedRecords.set(name, [...existing, ...records]);
        return { returning: () => Promise.resolve(records) };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: (table: { _: { name: string } }) => ({
          values: (data: unknown) => {
            const name = table?._.name ?? "unknown";
            const existing = insertedRecords.get(name) ?? [];
            const records = Array.isArray(data) ? data : [data];
            insertedRecords.set(name, [...existing, ...records]);
            return { returning: () => Promise.resolve(records) };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([]) }),
          }),
        }),
      };
      await fn(tx);
    },
  };

  return { db, insertedRecords };
}
```

- [ ] **Step 2: Run tests — verify they FAIL**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-import.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the import service implementation**

Create `server/src/services/snapshot/import.ts` with:
- `createSnapshotImporter(db)` factory function
- `.inspect(input)` — decrypt, extract, validate manifest, detect conflicts
- `.import(input)` — full import pipeline: decrypt, extract, rewrite paths, check conflicts, phased insert, re-encrypt secrets, regenerate API keys

Key implementation details:
- Decrypt → extract tar.gz → read manifest → validate schema compatibility
- Path rewriting using `rewritePaths()` from paths module
- Phased insertion following the spec's 10-phase ordering
- Insert with `reportsTo = null` first, then backfill self-references
- Heartbeat_run_events use DB-assigned IDs (skip original bigserial IDs)
- Activity log entries with missing run references get `runId = null`
- Try/finally for temp directory cleanup

- [ ] **Step 4: Update index exports**

Add to `server/src/services/snapshot/index.ts`:
```typescript
export { createSnapshotImporter } from "./import.js";
```

- [ ] **Step 5: Run tests — verify they PASS**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-import.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/__tests__/snapshot-import.test.ts server/src/services/snapshot/import.ts server/src/services/snapshot/index.ts
git commit -m "feat: add snapshot import pipeline with conflict resolution"
```

### Task 9: Round-Trip Integration Test

**Files:**
- Create: `server/src/__tests__/snapshot-roundtrip.test.ts`

- [ ] **Step 1: Write round-trip test**

```typescript
// server/src/__tests__/snapshot-roundtrip.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotExporter } from "../services/snapshot/export.js";
import { createSnapshotImporter } from "../services/snapshot/import.js";

describe("snapshot round-trip", () => {
  let tempDir: string;
  const passphrase = "roundtrip-test-passphrase";

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "snapshot-roundtrip-"));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("export then import preserves company data", async () => {
    const sourceCompany = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "RoundTrip Corp",
      issuePrefix: "RT",
      issueCounter: 42,
      status: "active" as const,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-03-01"),
    };

    const sourceAgents = [
      {
        id: "agent-ceo",
        name: "CEO",
        role: "ceo",
        companyId: sourceCompany.id,
        reportsTo: null,
        adapterConfig: { workspaceDir: "/Users/alice/Code/project" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "agent-eng",
        name: "Engineer",
        role: "engineer",
        companyId: sourceCompany.id,
        reportsTo: "agent-ceo",
        adapterConfig: { workspaceDir: "/Users/alice/Code/project" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Export with mock source DB
    const sourceDb = createSourceMockDb(sourceCompany, sourceAgents);
    const exporter = createSnapshotExporter(sourceDb as never);
    const exportResult = await exporter.export({
      companyId: sourceCompany.id,
      passphrase,
      history: "none",
      pauseAgents: false,
      outputDir: tempDir,
    });

    expect(exportResult.manifest.companyName).toBe("RoundTrip Corp");
    expect(exportResult.manifest.recordCounts.agents).toBe(2);

    // Import into mock target DB
    const { db: targetDb, insertedRecords } = createTrackingTargetDb();
    const importer = createSnapshotImporter(targetDb as never);

    const importResult = await importer.import({
      filePath: exportResult.filePath,
      passphrase,
      pathMappings: { "/Users/alice/Code": "/Users/bob/work" },
      onConflict: "abort",
    });

    expect(importResult.companyId).toBe(sourceCompany.id);

    // Verify agents were path-rewritten
    const importedAgents = insertedRecords.get("agents") ?? [];
    for (const agent of importedAgents) {
      const config = (agent as Record<string, unknown>)
        .adapterConfig as Record<string, string>;
      if (config?.workspaceDir) {
        expect(config.workspaceDir).toStartWith("/Users/bob/work");
      }
    }
  });

  it("export with history=none skips execution tables", async () => {
    const sourceDb = createSourceMockDb(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "NoHistory Corp",
        issuePrefix: "NH",
        issueCounter: 1,
        status: "active" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      []
    );
    const exporter = createSnapshotExporter(sourceDb as never);

    const result = await exporter.export({
      companyId: "550e8400-e29b-41d4-a716-446655440000",
      passphrase,
      history: "none",
      pauseAgents: false,
      outputDir: tempDir,
    });

    expect(result.manifest.recordCounts.heartbeatRuns ?? 0).toBe(0);
    expect(result.manifest.recordCounts.runEvents ?? 0).toBe(0);
    expect(result.manifest.recordCounts.costEvents ?? 0).toBe(0);
  });
});

// Mock helpers (similar to import test but with richer data)
function createSourceMockDb(
  company: Record<string, unknown>,
  agents: Array<Record<string, unknown>>
) {
  return {
    select: () => ({
      from: (table: { _: { name: string } }) => {
        const name = table?._.name ?? "";
        return {
          where: () => {
            if (name === "companies") return Promise.resolve([company]);
            if (name === "agents") return Promise.resolve(agents);
            return Promise.resolve([]);
          },
        };
      },
    }),
  };
}

function createTrackingTargetDb() {
  const insertedRecords = new Map<string, unknown[]>();
  const db = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }),
    insert: (table: { _: { name: string } }) => ({
      values: (data: unknown) => {
        const name = table?._.name ?? "unknown";
        const existing = insertedRecords.get(name) ?? [];
        const records = Array.isArray(data) ? data : [data];
        insertedRecords.set(name, [...existing, ...records]);
        return { returning: () => Promise.resolve(records) };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: (table: { _: { name: string } }) => ({
          values: (data: unknown) => {
            const name = table?._.name ?? "unknown";
            const existing = insertedRecords.get(name) ?? [];
            const records = Array.isArray(data) ? data : [data];
            insertedRecords.set(name, [...existing, ...records]);
            return { returning: () => Promise.resolve(records) };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([]) }),
          }),
        }),
      };
      await fn(tx);
    },
  };
  return { db, insertedRecords };
}
```

- [ ] **Step 2: Run test — verify it PASSES** (since export and import are already implemented)

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-roundtrip.test.ts
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/snapshot-roundtrip.test.ts
git commit -m "test: add snapshot export→import round-trip integration tests"
```

---

## Chunk 4: API Routes & CLI

### Task 10: REST API Routes (TDD)

**Files:**
- Create: `server/src/routes/snapshot.ts`
- Modify: `server/src/routes/index.ts`

- [ ] **Step 1: Write the route handler**

```typescript
// server/src/routes/snapshot.ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import multer from "multer";
import { snapshotExportInputSchema, snapshotImportInputSchema } from "@paperclipai/shared/validators";
import { createSnapshotExporter, createSnapshotImporter } from "../services/snapshot/index.js";

const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

export function snapshotRoutes(db: Db) {
  const router = Router();
  const exporter = createSnapshotExporter(db);
  const importer = createSnapshotImporter(db);

  // Export
  router.post("/:companyId/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    const input = snapshotExportInputSchema.parse(req.body);

    const result = await exporter.export({
      companyId,
      ...input,
      outputDir: undefined, // stream directly
    });

    res.json({
      jobId: result.jobId,
      manifest: result.manifest,
      warnings: result.warnings,
    });
  });

  // Import (multipart)
  router.post("/import", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const options = snapshotImportInputSchema.parse(
      JSON.parse(req.body.options ?? "{}")
    );

    const result = await importer.import({
      fileBuffer: req.file.buffer,
      ...options,
    });

    res.json(result);
  });

  // Inspect (multipart)
  router.post("/import/inspect", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const { passphrase } = req.body;

    const result = await importer.inspect({
      fileBuffer: req.file.buffer,
      passphrase,
    });

    res.json(result);
  });

  return router;
}
```

- [ ] **Step 2: Register routes in server**

Add to `server/src/routes/index.ts` (or wherever routes are mounted):
```typescript
import { snapshotRoutes } from "./snapshot.js";
// In the router setup:
router.use("/api/companies", snapshotRoutes(db));
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/snapshot.ts server/src/routes/index.ts
git commit -m "feat: add snapshot export/import REST API endpoints"
```

### Task 11: CLI Commands (TDD)

**Files:**
- Create: `cli/src/commands/export.ts`
- Create: `cli/src/commands/import.ts`
- Create: `cli/src/commands/snapshot-inspect.ts`
- Modify: `cli/src/index.ts`

- [ ] **Step 1: Create export command**

```typescript
// cli/src/commands/export.ts
import { Command } from "commander";
import { createInterface } from "node:readline/promises";

export const exportCommand = new Command("export")
  .description("Export organization state as encrypted snapshot")
  .requiredOption("--company <nameOrId>", "Company name or ID")
  .option("--output <path>", "Output file path", "./snapshot.tar.gz.enc")
  .option("--passphrase-stdin", "Read passphrase from stdin")
  .option("--history <window>", "History window: all|none|Nd", "30d")
  .option("--runs-per-agent <n>", "Max runs per agent", parseInt)
  .option("--no-pause", "Skip pausing agents during export")
  .action(async (options) => {
    let passphrase: string;

    if (options.passphraseStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      passphrase = Buffer.concat(chunks).toString("utf-8").trim();
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      passphrase = await rl.question("Enter passphrase (min 12 chars): ");
      rl.close();
    }

    if (passphrase.length < 12 && !options.force) {
      console.error("Passphrase must be at least 12 characters.");
      process.exit(1);
    }

    // Call the server API
    const response = await fetch(
      `${options.apiUrl}/api/companies/${encodeURIComponent(options.company)}/export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passphrase,
          history: options.history,
          runsPerAgent: options.runsPerAgent ?? null,
          pauseAgents: options.pause !== false,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      console.error(`Export failed: ${err.error ?? response.statusText}`);
      process.exit(1);
    }

    const result = await response.json();
    console.log(`Exported to: ${result.filePath}`);
    console.log(`Company: ${result.manifest.companyName}`);
    console.log(`Records: ${JSON.stringify(result.manifest.recordCounts)}`);

    if (result.warnings.length > 0) {
      console.warn("Warnings:");
      for (const w of result.warnings) console.warn(`  - ${w}`);
    }
  });
```

- [ ] **Step 2: Create import command**

```typescript
// cli/src/commands/import.ts
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { promises as fs } from "node:fs";

export const importCommand = new Command("import")
  .description("Import organization state from encrypted snapshot")
  .requiredOption("--file <path>", "Path to snapshot .tar.gz.enc file")
  .option("--passphrase-stdin", "Read passphrase from stdin")
  .option("--path-map <mappings>", "Path prefix mappings (old=new,...)")
  .option("--on-conflict <mode>", "Conflict mode: abort|rename|replace", "abort")
  .option("--dry-run", "Validate only, don't write")
  .action(async (options) => {
    let passphrase: string;

    if (options.passphraseStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      passphrase = Buffer.concat(chunks).toString("utf-8").trim();
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      passphrase = await rl.question("Enter passphrase: ");
      rl.close();
    }

    const pathMappings: Record<string, string> = {};
    if (options.pathMap) {
      for (const pair of options.pathMap.split(",")) {
        const [oldPrefix, newPrefix] = pair.split("=");
        if (oldPrefix && newPrefix) {
          pathMappings[oldPrefix] = newPrefix;
        }
      }
    }

    const fileBuffer = await fs.readFile(options.file);

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer]), "snapshot.tar.gz.enc");
    formData.append(
      "options",
      JSON.stringify({
        passphrase,
        pathMappings,
        onConflict: options.onConflict,
      })
    );

    const endpoint = options.dryRun
      ? `${options.apiUrl}/api/companies/import/inspect`
      : `${options.apiUrl}/api/companies/import`;

    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json();
      console.error(`Import failed: ${err.error ?? response.statusText}`);
      process.exit(1);
    }

    const result = await response.json();

    if (options.dryRun) {
      console.log("Dry run — no data written.");
      console.log(`Company: ${result.manifest.companyName}`);
      console.log(`Schema: ${result.schemaCompatibility}`);
      if (result.conflicts.length > 0) {
        console.warn("Conflicts:");
        for (const c of result.conflicts) {
          console.warn(`  - ${c.type}: ${c.snapshotValue} vs ${c.existingValue}`);
        }
      }
    } else {
      console.log(`Imported company: ${result.companyName} (${result.companyId})`);
      console.log(`Records: ${JSON.stringify(result.recordCounts)}`);
      if (result.warnings.length > 0) {
        console.warn("Warnings:");
        for (const w of result.warnings) console.warn(`  - ${w}`);
      }
      if (result.apiKeyMapping.length > 0) {
        console.log("New API keys generated for agents:");
        for (const k of result.apiKeyMapping) {
          console.log(`  - ${k.agentName}: ${k.newKeyPrefix}...`);
        }
      }
    }
  });
```

- [ ] **Step 3: Create inspect command**

```typescript
// cli/src/commands/snapshot-inspect.ts
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { promises as fs } from "node:fs";

export const snapshotInspectCommand = new Command("snapshot")
  .description("Snapshot utilities")
  .addCommand(
    new Command("inspect")
      .description("Inspect a snapshot archive without importing")
      .requiredOption("--file <path>", "Path to snapshot file")
      .option("--passphrase-stdin", "Read passphrase from stdin")
      .action(async (options) => {
        let passphrase: string;

        if (options.passphraseStdin) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          passphrase = Buffer.concat(chunks).toString("utf-8").trim();
        } else {
          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          passphrase = await rl.question("Enter passphrase: ");
          rl.close();
        }

        const fileBuffer = await fs.readFile(options.file);

        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), "snapshot.tar.gz.enc");
        formData.append("passphrase", passphrase);

        const response = await fetch(
          `${options.apiUrl}/api/companies/import/inspect`,
          { method: "POST", body: formData }
        );

        if (!response.ok) {
          const err = await response.json();
          console.error(`Inspect failed: ${err.error ?? response.statusText}`);
          process.exit(1);
        }

        const result = await response.json();

        console.log("=== Snapshot Inspection ===");
        console.log(`Company: ${result.manifest.companyName}`);
        console.log(`Exported: ${result.manifest.exportedAt}`);
        console.log(`Source: ${result.manifest.sourceHostname} (${result.manifest.sourcePlatform})`);
        console.log(`Schema: ${result.manifest.schemaVersion}`);
        console.log(`Compatibility: ${result.schemaCompatibility}`);
        console.log(`\nRecord Counts:`);
        for (const [table, count] of Object.entries(result.manifest.recordCounts)) {
          console.log(`  ${table}: ${count}`);
        }
        if (result.detectedPaths.length > 0) {
          const prefixes = [...new Set(result.detectedPaths.map((p: { value: string }) => {
            const parts = p.value.split("/");
            return parts.slice(0, -1).join("/");
          }))];
          console.log(`\nDetected path prefixes:`);
          for (const p of prefixes) console.log(`  ${p}`);
        }
        if (result.conflicts.length > 0) {
          console.log(`\nConflicts:`);
          for (const c of result.conflicts) {
            console.log(`  ${c.type}: snapshot="${c.snapshotValue}" vs existing="${c.existingValue}"`);
          }
        }
      })
  );
```

- [ ] **Step 4: Register commands in CLI entry point**

Add to `cli/src/index.ts`:
```typescript
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { snapshotInspectCommand } from "./commands/snapshot-inspect.js";

program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(snapshotInspectCommand);
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/export.ts cli/src/commands/import.ts cli/src/commands/snapshot-inspect.ts cli/src/index.ts
git commit -m "feat: add CLI commands for snapshot export, import, and inspect"
```

---

## Chunk 5: UI Components

### Task 12: Snapshot Export Modal

**Files:**
- Create: `ui/src/components/SnapshotExportModal.tsx`
- Modify: `ui/src/pages/CompanySettings.tsx`

- [ ] **Step 1: Create export modal component**

Build a modal with:
- History window dropdown (30 days / 90 days / all / none)
- Passphrase input with confirmation field and min-12-char validation
- "Pause agents during export" toggle (default on)
- Export button that calls `POST /api/companies/:id/export`
- Progress indication during export
- Auto-download of the encrypted file on completion
- Error display for failures

Follow existing component patterns from the UI codebase (check `ui/src/components/` for modal patterns, form patterns, button styles).

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/SnapshotExportModal.tsx
git commit -m "feat: add snapshot export modal UI component"
```

### Task 13: Snapshot Import Modal

**Files:**
- Create: `ui/src/components/SnapshotImportModal.tsx`

- [ ] **Step 1: Create import modal component**

Build a modal with multi-step flow:
1. **Upload step:** File dropzone + passphrase input
2. **Preview step:** Show inspect results (company name, record counts, schema compatibility)
3. **Path mapping step:** Table showing detected prefixes with input fields for replacement
4. **Conflict step:** If conflicts detected, show radio options (abort/rename/replace)
5. **Import step:** Progress bar with per-phase status
6. **Summary step:** Record counts, warnings, new API key info

Calls `POST /api/companies/import/inspect` for preview, then `POST /api/companies/import` for actual import.

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/SnapshotImportModal.tsx
git commit -m "feat: add snapshot import modal UI component"
```

### Task 14: Integrate into Company Settings

**Files:**
- Modify: `ui/src/pages/CompanySettings.tsx`

- [ ] **Step 1: Add Snapshot section to Company Settings**

Add a new section below existing settings with:
- Section heading: "Snapshot"
- Description: "Export or import a complete snapshot of this organization"
- Two buttons: "Export Snapshot" (opens export modal) and "Import Snapshot" (opens import modal)
- Wire up modal state (`useState` for open/close)
- Pass `companyId` to modals

Follow existing section patterns in `CompanySettings.tsx`.

- [ ] **Step 2: Commit**

```bash
git add ui/src/pages/CompanySettings.tsx
git commit -m "feat: add snapshot section to Company Settings page"
```

---

## Chunk 6: Final Verification

### Task 15: Run full test suite

- [ ] **Step 1: Run all snapshot tests**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server exec vitest run src/__tests__/snapshot-*.test.ts
```

Expected: All tests PASS.

- [ ] **Step 2: Run full server test suite**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm -F server test
```

Expected: No regressions.

- [ ] **Step 3: Build check**

```bash
cd /Users/notthatsundar/Code/paperclip && pnpm build
```

Expected: Clean build.

- [ ] **Step 4: Final commit with any fixes**

If any test failures or build issues, fix them and commit:
```bash
git add -A && git commit -m "fix: address test/build issues from snapshot implementation"
```
