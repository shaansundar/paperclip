import { describe, expect, it } from "vitest";
import { buildManifest, validateManifest, computeChecksum } from "../services/snapshot/manifest.js";

describe("computeChecksum", () => {
  it("returns sha256 hex prefixed with 'sha256:'", () => {
    const result = computeChecksum(Buffer.from("hello"));
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns same hash for same input", () => {
    const buf = Buffer.from("deterministic");
    expect(computeChecksum(buf)).toBe(computeChecksum(buf));
  });

  it("returns different hash for different input", () => {
    const a = computeChecksum(Buffer.from("alpha"));
    const b = computeChecksum(Buffer.from("beta"));
    expect(a).not.toBe(b);
  });
});

describe("buildManifest", () => {
  it("builds a valid manifest with version=1, timestamps, hostname, platform", () => {
    const manifest = buildManifest({
      companyId: "00000000-0000-0000-0000-000000000001",
      companyName: "Acme Corp",
      options: { historyWindow: "30d", runsPerAgent: null, agentsPaused: true },
      recordCounts: { agents: 3 },
      checksums: { "agents.json": "sha256:abc" },
      assetsIncomplete: false,
      consistentSnapshot: true,
    });

    expect(manifest.version).toBe(1);
    expect(manifest.exportedAt).toBeTruthy();
    expect(() => new Date(manifest.exportedAt)).not.toThrow();
    expect(manifest.sourceHostname).toBeTruthy();
    expect(manifest.sourcePlatform).toBeTruthy();
    expect(manifest.companyId).toBe("00000000-0000-0000-0000-000000000001");
    expect(manifest.companyName).toBe("Acme Corp");
    expect(manifest.paperclipVersion).toBeTruthy();
    expect(manifest.schemaVersion).toBeTruthy();
  });
});

describe("validateManifest", () => {
  const validRaw = {
    version: 1,
    paperclipVersion: "0.3.0",
    schemaVersion: "1",
    exportedAt: new Date().toISOString(),
    sourceHostname: "myhost",
    sourcePlatform: "linux",
    companyId: "00000000-0000-0000-0000-000000000001",
    companyName: "Acme Corp",
    options: { historyWindow: "30d", runsPerAgent: null, agentsPaused: true },
    recordCounts: { agents: 3 },
    checksums: { "agents.json": "sha256:abc" },
    assetsIncomplete: false,
    consistentSnapshot: true,
  };

  it("accepts a valid manifest (built by buildManifest)", () => {
    const built = buildManifest({
      companyId: "00000000-0000-0000-0000-000000000001",
      companyName: "Acme Corp",
      options: { historyWindow: "30d", runsPerAgent: null, agentsPaused: true },
      recordCounts: {},
      checksums: {},
      assetsIncomplete: false,
      consistentSnapshot: true,
    });
    expect(() => validateManifest(built)).not.toThrow();
  });

  it("rejects manifest with missing required fields", () => {
    const bad = { version: 1 };
    expect(() => validateManifest(bad)).toThrow();
  });

  it("rejects manifest with unsupported version (e.g., version: 99)", () => {
    const bad = { ...validRaw, version: 99 };
    expect(() => validateManifest(bad)).toThrow();
  });
});
