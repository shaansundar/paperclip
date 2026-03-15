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
