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
  historyWindow: "all" | "none" | string;
  runsPerAgent: number | null;
  agentsPaused: boolean;
}

export interface SnapshotExportInput {
  passphrase: string;
  history?: string;
  runsPerAgent?: number;
  pauseAgents?: boolean;
}

export interface SnapshotExportResult {
  filePath: string;
  manifest: SnapshotManifest;
  warnings: string[];
}

export interface SnapshotImportInput {
  passphrase: string;
  pathMappings?: Record<string, string>;
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
