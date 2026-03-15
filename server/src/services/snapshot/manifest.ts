import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { snapshotManifestSchema } from "@paperclipai/shared";
import type { SnapshotManifest, SnapshotExportOptions } from "@paperclipai/shared";

const MANIFEST_VERSION = 1;
const SCHEMA_VERSION = "1";
const PAPERCLIP_VERSION = "0.3.0";

export interface BuildManifestInput {
  companyId: string;
  companyName: string;
  options: SnapshotExportOptions;
  recordCounts: Record<string, number>;
  checksums: Record<string, string>;
  assetsIncomplete: boolean;
  consistentSnapshot: boolean;
}

export function computeChecksum(data: Buffer): string {
  const hex = createHash("sha256").update(data).digest("hex");
  return `sha256:${hex}`;
}

export function buildManifest(input: BuildManifestInput): SnapshotManifest {
  return {
    version: MANIFEST_VERSION,
    paperclipVersion: PAPERCLIP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceHostname: hostname(),
    sourcePlatform: process.platform,
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
  if (parsed.version > MANIFEST_VERSION) {
    throw new Error(
      `Unsupported manifest version ${parsed.version}; maximum supported is ${MANIFEST_VERSION}`
    );
  }
  return parsed as SnapshotManifest;
}
