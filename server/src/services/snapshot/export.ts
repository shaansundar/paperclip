import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import { encryptBuffer } from "./encryption.js";
import { detectPaths } from "./paths.js";
import { buildManifest, computeChecksum } from "./manifest.js";
import type { SnapshotManifest } from "@paperclipai/shared";
import {
  companies,
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  goals,
  projects,
  projectWorkspaces,
  projectGoals,
  workspaceRuntimeServices,
  issues,
  issueComments,
  labels,
  issueLabels,
  issueApprovals,
  issueReadStates,
  issueAttachments,
  assets,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  approvals,
  approvalComments,
  activityLog,
  companySecrets,
  companySecretVersions,
  companyMemberships,
  principalPermissionGrants,
} from "@paperclipai/db";
import { eq, and, gte, getTableName } from "drizzle-orm";

export interface SnapshotExportInput {
  companyId: string;
  passphrase: string;
  history: string;
  runsPerAgent?: number;
  pauseAgents: boolean;
  outputDir?: string;
}

export interface SnapshotExportResult {
  filePath: string;
  manifest: SnapshotManifest;
  warnings: string[];
}

// Tables that are always included (filtered by companyId only)
const CORE_TABLES = [
  { table: agents, dir: "agents", file: "agents.json", key: "agents" },
  { table: agentConfigRevisions, dir: "agents", file: "agent_config_revisions.json", key: "agentConfigRevisions" },
  { table: agentApiKeys, dir: "agents", file: "agent_api_keys.json", key: "agentApiKeys" },
  { table: agentRuntimeState, dir: "agents", file: "agent_runtime_state.json", key: "agentRuntimeState" },
  { table: agentTaskSessions, dir: "agents", file: "agent_task_sessions.json", key: "agentTaskSessions" },
  { table: agentWakeupRequests, dir: "agents", file: "agent_wakeup_requests.json", key: "agentWakeupRequests" },
  { table: goals, dir: "goals", file: "goals.json", key: "goals" },
  { table: projects, dir: "projects", file: "projects.json", key: "projects" },
  { table: projectWorkspaces, dir: "projects", file: "project_workspaces.json", key: "projectWorkspaces" },
  { table: projectGoals, dir: "projects", file: "project_goals.json", key: "projectGoals" },
  { table: workspaceRuntimeServices, dir: "projects", file: "workspace_runtime_services.json", key: "workspaceRuntimeServices" },
  { table: issues, dir: "issues", file: "issues.json", key: "issues" },
  { table: issueComments, dir: "issues", file: "issue_comments.json", key: "issueComments" },
  { table: labels, dir: "issues", file: "labels.json", key: "labels" },
  { table: issueLabels, dir: "issues", file: "issue_labels.json", key: "issueLabels" },
  { table: issueApprovals, dir: "issues", file: "issue_approvals.json", key: "issueApprovals" },
  { table: issueReadStates, dir: "issues", file: "issue_read_states.json", key: "issueReadStates" },
  { table: issueAttachments, dir: "issues", file: "issue_attachments.json", key: "issueAttachments" },
  { table: assets, dir: "issues", file: "assets.json", key: "assets" },
  { table: approvals, dir: "governance", file: "approvals.json", key: "approvals" },
  { table: approvalComments, dir: "governance", file: "approval_comments.json", key: "approvalComments" },
  { table: companySecrets, dir: "secrets", file: "company_secrets.json", key: "companySecrets" },
  { table: companySecretVersions, dir: "secrets", file: "company_secret_versions.json", key: "companySecretVersions" },
  { table: companyMemberships, dir: "governance", file: "company_memberships.json", key: "companyMemberships" },
  { table: principalPermissionGrants, dir: "governance", file: "principal_permission_grants.json", key: "principalPermissionGrants" },
] as const;

// History tables (skipped when history === "none", filtered by createdAt when history === "Nd")
const HISTORY_TABLES = [
  { table: heartbeatRuns, dir: "execution", file: "heartbeat_runs.json", key: "heartbeatRuns" },
  { table: heartbeatRunEvents, dir: "execution", file: "heartbeat_run_events.json", key: "heartbeatRunEvents" },
  { table: costEvents, dir: "execution", file: "cost_events.json", key: "costEvents" },
  { table: activityLog, dir: "execution", file: "activity_log.json", key: "activityLog" },
] as const;

function computeHistoryCutoff(history: string): Date | null {
  if (history === "all" || history === "none") return null;
  const match = /^(\d+)d$/.exec(history);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

export function createSnapshotExporter(db: any) {
  return {
    async export(input: SnapshotExportInput): Promise<SnapshotExportResult> {
      const outputDir = input.outputDir ?? os.tmpdir();
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-"));

      try {
        return await runExport(db, input, tempDir, outputDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

async function runExport(
  db: any,
  input: SnapshotExportInput,
  tempDir: string,
  outputDir: string,
): Promise<SnapshotExportResult> {
  const { companyId, passphrase, history, runsPerAgent, pauseAgents } = input;
  const warnings: string[] = [];

  // 1. Query company — companies table uses a different column name (id, not companyId)
  const companyRows: Array<Record<string, unknown>> = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId));

  if (!companyRows || companyRows.length === 0) {
    throw new Error(`Company not found: ${companyId}`);
  }
  const company = companyRows[0];
  const companyName = String(company["name"] ?? "");

  // 2. Create directory structure
  const dirs = ["agents", "goals", "projects", "issues", "execution", "governance", "secrets"];
  await Promise.all(dirs.map((d) => fs.mkdir(path.join(tempDir, d), { recursive: true })));

  // 3. Write company.json
  const companyJson = Buffer.from(JSON.stringify([company], null, 2));
  await fs.writeFile(path.join(tempDir, "company.json"), companyJson);

  const recordCounts: Record<string, number> = {};
  const checksums: Record<string, string> = {};

  checksums["company.json"] = computeChecksum(companyJson);
  recordCounts["companies"] = 1;

  // 4. Query and write core tables
  const allAgentRows: Array<Record<string, unknown>> = [];
  const allWorkspaceRows: Array<Record<string, unknown>> = [];

  for (const entry of CORE_TABLES) {
    const rows: Array<Record<string, unknown>> = await db
      .select()
      .from(entry.table)
      .where(eq((entry.table as any).companyId, companyId));

    const buf = Buffer.from(JSON.stringify(rows, null, 2));
    const relPath = path.join(entry.dir, entry.file);
    await fs.writeFile(path.join(tempDir, relPath), buf);
    checksums[relPath] = computeChecksum(buf);
    recordCounts[entry.key] = rows.length;

    if (entry.key === "agents") {
      allAgentRows.push(...rows);
    }
    if (entry.key === "projectWorkspaces") {
      allWorkspaceRows.push(...rows);
    }
  }

  // 5. History tables
  const includeHistory = history !== "none";
  const cutoff = computeHistoryCutoff(history);

  if (includeHistory) {
    for (const entry of HISTORY_TABLES) {
      let rows: Array<Record<string, unknown>>;

      if (cutoff) {
        rows = await db
          .select()
          .from(entry.table)
          .where(
            and(
              eq((entry.table as any).companyId, companyId),
              gte((entry.table as any).createdAt, cutoff),
            ),
          );
      } else {
        rows = await db
          .select()
          .from(entry.table)
          .where(eq((entry.table as any).companyId, companyId));
      }

      const buf = Buffer.from(JSON.stringify(rows, null, 2));
      const relPath = path.join(entry.dir, entry.file);
      await fs.writeFile(path.join(tempDir, relPath), buf);
      checksums[relPath] = computeChecksum(buf);
      recordCounts[entry.key] = rows.length;
    }
  }

  // 6. Detect paths
  const agentPathResult = detectPaths("agents", allAgentRows, ["adapterConfig.workspaceDir"]);
  const workspacePathResult = detectPaths("projectWorkspaces", allWorkspaceRows, ["cwd"]);

  const allPathEntries = [...agentPathResult.entries, ...workspacePathResult.entries];
  const allPrefixes = Array.from(new Set([...agentPathResult.prefixes, ...workspacePathResult.prefixes]));

  if (allPathEntries.length > 0 || allPrefixes.length > 0) {
    const pathMappings = { entries: allPathEntries, prefixes: allPrefixes };
    const buf = Buffer.from(JSON.stringify(pathMappings, null, 2));
    await fs.writeFile(path.join(tempDir, "path_mappings.json"), buf);
    checksums["path_mappings.json"] = computeChecksum(buf);

    if (allPrefixes.length > 0) {
      warnings.push(
        `Detected ${allPrefixes.length} absolute path prefix(es) in snapshot. Provide path_mappings during import.`,
      );
    }
  }

  // 7. Build manifest
  const manifest = buildManifest({
    companyId,
    companyName,
    options: {
      historyWindow: history,
      runsPerAgent: runsPerAgent ?? null,
      agentsPaused: pauseAgents,
    },
    recordCounts,
    checksums,
    assetsIncomplete: false,
    consistentSnapshot: false,
  });

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(tempDir, "manifest.json"), manifestBuf);

  // 8. Create tar.gz in a temporary output path
  const tarGzName = `paperclip-snapshot-${Date.now()}.tar.gz`;
  const tarGzPath = path.join(os.tmpdir(), tarGzName);
  await tarCreate({ gzip: true, cwd: tempDir, file: tarGzPath }, ["."]);

  // 9. Read tar.gz, encrypt, remove intermediate file
  const tarGzBuffer = await fs.readFile(tarGzPath);
  await fs.rm(tarGzPath, { force: true });

  const encrypted = await encryptBuffer(tarGzBuffer, passphrase);

  // 10. Write encrypted file to outputDir
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `paperclip-snapshot-${timestamp}.enc`;
  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, encrypted);

  return { filePath, manifest, warnings };
}
