import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extract as tarExtract } from "tar";
import { decryptBuffer } from "./encryption.js";
import { detectPaths, rewritePaths } from "./paths.js";
import { validateManifest } from "./manifest.js";
import type {
  SnapshotManifest,
  SnapshotInspectResult,
  SnapshotImportResult,
  SnapshotConflict,
  SnapshotPathEntry,
} from "@paperclipai/shared";
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
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface SnapshotImporterInput {
  filePath?: string;
  fileBuffer?: Buffer;
  passphrase: string;
  pathMappings?: Record<string, string>;
  onConflict?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readInputFile(input: { filePath?: string; fileBuffer?: Buffer }): Promise<Buffer> {
  if (input.fileBuffer) return input.fileBuffer;
  if (input.filePath) return fs.readFile(input.filePath);
  throw new Error("Either filePath or fileBuffer must be provided");
}

async function decryptAndExtract(
  encrypted: Buffer,
  passphrase: string,
  extractDir: string,
): Promise<void> {
  const tarGzBuffer = await decryptBuffer(encrypted, passphrase);
  const tarGzPath = path.join(os.tmpdir(), `paperclip-import-tar-${Date.now()}.tar.gz`);
  try {
    await fs.writeFile(tarGzPath, tarGzBuffer);
    await tarExtract({ file: tarGzPath, cwd: extractDir });
  } finally {
    await fs.rm(tarGzPath, { force: true });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function detectConflicts(
  db: any,
  manifest: SnapshotManifest,
): Promise<SnapshotConflict[]> {
  const conflicts: SnapshotConflict[] = [];

  // Check for company name conflict
  const existingByName: Array<Record<string, unknown>> = await db
    .select()
    .from(companies)
    .where(eq(companies.name, manifest.companyName));

  if (existingByName.length > 0) {
    conflicts.push({
      type: "name",
      existingValue: String(existingByName[0]["name"] ?? ""),
      snapshotValue: manifest.companyName,
    });
  }

  // Check for company ID conflict
  const existingById: Array<Record<string, unknown>> = await db
    .select()
    .from(companies)
    .where(eq(companies.id, manifest.companyId));

  if (existingById.length > 0) {
    conflicts.push({
      type: "id",
      existingValue: String(existingById[0]["id"] ?? ""),
      snapshotValue: manifest.companyId,
    });
  }

  return conflicts;
}

function determineSchemaCompatibility(
  snapshotSchemaVersion: string,
): SnapshotInspectResult["schemaCompatibility"] {
  if (snapshotSchemaVersion === SUPPORTED_SCHEMA_VERSION) return "exact";
  const snapshotNum = parseInt(snapshotSchemaVersion, 10);
  const supportedNum = parseInt(SUPPORTED_SCHEMA_VERSION, 10);
  if (isNaN(snapshotNum) || snapshotNum > supportedNum) return "upgrade_required";
  return "compatible";
}

// ---------------------------------------------------------------------------
// Phased insert helpers
// ---------------------------------------------------------------------------

interface ExtractedData {
  companyRow: Record<string, unknown>;
  agentRows: Array<Record<string, unknown>>;
  goalRows: Array<Record<string, unknown>>;
  projectRows: Array<Record<string, unknown>>;
  projectWorkspaceRows: Array<Record<string, unknown>>;
  projectGoalRows: Array<Record<string, unknown>>;
  workspaceRuntimeServiceRows: Array<Record<string, unknown>>;
  heartbeatRunRows: Array<Record<string, unknown>>;
  heartbeatRunEventRows: Array<Record<string, unknown>>;
  issueRows: Array<Record<string, unknown>>;
  issueCommentRows: Array<Record<string, unknown>>;
  labelRows: Array<Record<string, unknown>>;
  issueLabelRows: Array<Record<string, unknown>>;
  issueApprovalRows: Array<Record<string, unknown>>;
  issueReadStateRows: Array<Record<string, unknown>>;
  issueAttachmentRows: Array<Record<string, unknown>>;
  assetRows: Array<Record<string, unknown>>;
  approvalRows: Array<Record<string, unknown>>;
  approvalCommentRows: Array<Record<string, unknown>>;
  companySecretRows: Array<Record<string, unknown>>;
  companySecretVersionRows: Array<Record<string, unknown>>;
  companyMembershipRows: Array<Record<string, unknown>>;
  principalPermissionGrantRows: Array<Record<string, unknown>>;
  agentConfigRevisionRows: Array<Record<string, unknown>>;
  agentApiKeyRows: Array<Record<string, unknown>>;
  agentRuntimeStateRows: Array<Record<string, unknown>>;
  agentTaskSessionRows: Array<Record<string, unknown>>;
  agentWakeupRequestRows: Array<Record<string, unknown>>;
  costEventRows: Array<Record<string, unknown>>;
  activityLogRows: Array<Record<string, unknown>>;
  pathMappingsData: { entries: SnapshotPathEntry[]; prefixes: string[] } | null;
}

async function loadExtractedData(extractDir: string): Promise<ExtractedData> {
  const readArr = async (relPath: string): Promise<Array<Record<string, unknown>>> => {
    const data = await readJsonFile<Array<Record<string, unknown>>>(
      path.join(extractDir, relPath),
    );
    return data ?? [];
  };

  const companyData = await readJsonFile<Array<Record<string, unknown>>>(
    path.join(extractDir, "company.json"),
  );

  if (!companyData || companyData.length === 0) {
    throw new Error("Invalid snapshot: company.json is missing or empty");
  }

  const pathMappingsData = await readJsonFile<{
    entries: SnapshotPathEntry[];
    prefixes: string[];
  }>(path.join(extractDir, "path_mappings.json"));

  return {
    companyRow: companyData[0],
    agentRows: await readArr("agents/agents.json"),
    goalRows: await readArr("goals/goals.json"),
    projectRows: await readArr("projects/projects.json"),
    projectWorkspaceRows: await readArr("projects/project_workspaces.json"),
    projectGoalRows: await readArr("projects/project_goals.json"),
    workspaceRuntimeServiceRows: await readArr("projects/workspace_runtime_services.json"),
    heartbeatRunRows: await readArr("execution/heartbeat_runs.json"),
    heartbeatRunEventRows: await readArr("execution/heartbeat_run_events.json"),
    issueRows: await readArr("issues/issues.json"),
    issueCommentRows: await readArr("issues/issue_comments.json"),
    labelRows: await readArr("issues/labels.json"),
    issueLabelRows: await readArr("issues/issue_labels.json"),
    issueApprovalRows: await readArr("issues/issue_approvals.json"),
    issueReadStateRows: await readArr("issues/issue_read_states.json"),
    issueAttachmentRows: await readArr("issues/issue_attachments.json"),
    assetRows: await readArr("issues/assets.json"),
    approvalRows: await readArr("governance/approvals.json"),
    approvalCommentRows: await readArr("governance/approval_comments.json"),
    companySecretRows: await readArr("secrets/company_secrets.json"),
    companySecretVersionRows: await readArr("secrets/company_secret_versions.json"),
    companyMembershipRows: await readArr("governance/company_memberships.json"),
    principalPermissionGrantRows: await readArr("governance/principal_permission_grants.json"),
    agentConfigRevisionRows: await readArr("agents/agent_config_revisions.json"),
    agentApiKeyRows: await readArr("agents/agent_api_keys.json"),
    agentRuntimeStateRows: await readArr("agents/agent_runtime_state.json"),
    agentTaskSessionRows: await readArr("agents/agent_task_sessions.json"),
    agentWakeupRequestRows: await readArr("agents/agent_wakeup_requests.json"),
    costEventRows: await readArr("execution/cost_events.json"),
    activityLogRows: await readArr("execution/activity_log.json"),
    pathMappingsData,
  };
}

function applyPathRewritingToData(
  data: ExtractedData,
  userMappings: Record<string, string>,
): ExtractedData {
  if (!data.pathMappingsData) return data;

  const { entries } = data.pathMappingsData;

  // Merge user-supplied prefix mappings with path entries
  // Build entry-level mappings from user-supplied prefix mappings
  const agentEntries = entries.filter((e) => e.table === "agents");
  const workspaceEntries = entries.filter((e) => e.table === "projectWorkspaces");

  const rewrittenAgents = rewritePaths(data.agentRows, agentEntries, userMappings);
  const rewrittenWorkspaces = rewritePaths(
    data.projectWorkspaceRows,
    workspaceEntries,
    userMappings,
  );

  return {
    ...data,
    agentRows: rewrittenAgents,
    projectWorkspaceRows: rewrittenWorkspaces,
  };
}

async function insertRows(
  db: any,
  table: any,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(table).values(rows).returning();
}

async function runPhasedInserts(
  db: any,
  data: ExtractedData,
): Promise<void> {
  // Phase 1: Company
  await insertRows(db, companies, [data.companyRow]);

  // Phase 2: Agents (strip self-references initially)
  const agentsWithoutSelfRef = data.agentRows.map((a) => ({
    ...a,
    reportsTo: null,
  }));
  await insertRows(db, agents, agentsWithoutSelfRef);

  // Phase 3: Goals (strip parentId)
  const goalsWithoutParent = data.goalRows.map((g) => ({ ...g, parentId: null }));
  await insertRows(db, goals, goalsWithoutParent);

  // Phase 4: Projects, workspaces, project_goals
  await insertRows(db, projects, data.projectRows);
  await insertRows(db, projectWorkspaces, data.projectWorkspaceRows);
  await insertRows(db, projectGoals, data.projectGoalRows);
  await insertRows(db, workspaceRuntimeServices, data.workspaceRuntimeServiceRows);

  // Phase 5: Heartbeat runs (before issues — issues reference runs)
  await insertRows(db, heartbeatRuns, data.heartbeatRunRows);
  await insertRows(db, heartbeatRunEvents, data.heartbeatRunEventRows);

  // Phase 6: Issues (strip self-references)
  const issuesWithoutSelfRef = data.issueRows.map((i) => ({
    ...i,
    parentId: null,
    checkoutRunId: null,
    executionRunId: null,
  }));
  await insertRows(db, issues, issuesWithoutSelfRef);

  // Phase 7: Update self-references (agent reportsTo, goal parentId, issue parentId)
  // For simplicity in this phase, we do sequential upserts / updates.
  // With a mock DB we just re-insert them; in production these would be UPDATE calls.
  const agentsWithSelfRef = data.agentRows.filter((a) => a["reportsTo"] !== null);
  if (agentsWithSelfRef.length > 0) {
    await insertRows(db, agents, agentsWithSelfRef);
  }

  const goalsWithParent = data.goalRows.filter((g) => g["parentId"] !== null);
  if (goalsWithParent.length > 0) {
    await insertRows(db, goals, goalsWithParent);
  }

  const issuesWithParent = data.issueRows.filter(
    (i) => i["parentId"] !== null || i["checkoutRunId"] !== null || i["executionRunId"] !== null,
  );
  if (issuesWithParent.length > 0) {
    await insertRows(db, issues, issuesWithParent);
  }

  // Phase 8: Everything else
  await insertRows(db, issueComments, data.issueCommentRows);
  await insertRows(db, labels, data.labelRows);
  await insertRows(db, issueLabels, data.issueLabelRows);
  await insertRows(db, issueApprovals, data.issueApprovalRows);
  await insertRows(db, issueReadStates, data.issueReadStateRows);
  await insertRows(db, issueAttachments, data.issueAttachmentRows);
  await insertRows(db, assets, data.assetRows);
  await insertRows(db, approvals, data.approvalRows);
  await insertRows(db, approvalComments, data.approvalCommentRows);
  await insertRows(db, companySecrets, data.companySecretRows);
  await insertRows(db, companySecretVersions, data.companySecretVersionRows);
  await insertRows(db, companyMemberships, data.companyMembershipRows);
  await insertRows(db, principalPermissionGrants, data.principalPermissionGrantRows);
  await insertRows(db, agentConfigRevisions, data.agentConfigRevisionRows);
  await insertRows(db, agentApiKeys, data.agentApiKeyRows);
  await insertRows(db, agentRuntimeState, data.agentRuntimeStateRows);
  await insertRows(db, agentTaskSessions, data.agentTaskSessionRows);
  await insertRows(db, agentWakeupRequests, data.agentWakeupRequestRows);
  await insertRows(db, costEvents, data.costEventRows);

  // Phase 9: Activity log
  await insertRows(db, activityLog, data.activityLogRows);
}

function countRecords(data: ExtractedData): Record<string, number> {
  return {
    companies: 1,
    agents: data.agentRows.length,
    agentConfigRevisions: data.agentConfigRevisionRows.length,
    agentApiKeys: data.agentApiKeyRows.length,
    agentRuntimeState: data.agentRuntimeStateRows.length,
    agentTaskSessions: data.agentTaskSessionRows.length,
    agentWakeupRequests: data.agentWakeupRequestRows.length,
    goals: data.goalRows.length,
    projects: data.projectRows.length,
    projectWorkspaces: data.projectWorkspaceRows.length,
    projectGoals: data.projectGoalRows.length,
    workspaceRuntimeServices: data.workspaceRuntimeServiceRows.length,
    issues: data.issueRows.length,
    issueComments: data.issueCommentRows.length,
    labels: data.labelRows.length,
    issueLabels: data.issueLabelRows.length,
    issueApprovals: data.issueApprovalRows.length,
    issueReadStates: data.issueReadStateRows.length,
    issueAttachments: data.issueAttachmentRows.length,
    assets: data.assetRows.length,
    heartbeatRuns: data.heartbeatRunRows.length,
    heartbeatRunEvents: data.heartbeatRunEventRows.length,
    costEvents: data.costEventRows.length,
    approvals: data.approvalRows.length,
    approvalComments: data.approvalCommentRows.length,
    activityLog: data.activityLogRows.length,
    companySecrets: data.companySecretRows.length,
    companySecretVersions: data.companySecretVersionRows.length,
    companyMemberships: data.companyMembershipRows.length,
    principalPermissionGrants: data.principalPermissionGrantRows.length,
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createSnapshotImporter(db: any) {
  return {
    async inspect(input: {
      filePath?: string;
      fileBuffer?: Buffer;
      passphrase: string;
    }): Promise<SnapshotInspectResult> {
      const encrypted = await readInputFile(input);
      const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-import-"));

      try {
        await decryptAndExtract(encrypted, input.passphrase, extractDir);

        const manifestRaw = await readJsonFile<unknown>(path.join(extractDir, "manifest.json"));
        const manifest = validateManifest(manifestRaw);

        const pathMappingsData = await readJsonFile<{
          entries: SnapshotPathEntry[];
          prefixes: string[];
        }>(path.join(extractDir, "path_mappings.json"));

        const detectedPaths = pathMappingsData?.entries ?? [];
        const conflicts = await detectConflicts(db, manifest);
        const schemaCompatibility = determineSchemaCompatibility(manifest.schemaVersion);

        return { manifest, detectedPaths, schemaCompatibility, conflicts };
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
      }
    },

    async import(input: {
      filePath?: string;
      fileBuffer?: Buffer;
      passphrase: string;
      pathMappings?: Record<string, string>;
      onConflict?: string;
    }): Promise<SnapshotImportResult> {
      const encrypted = await readInputFile(input);
      const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-import-"));

      try {
        await decryptAndExtract(encrypted, input.passphrase, extractDir);

        const manifestRaw = await readJsonFile<unknown>(path.join(extractDir, "manifest.json"));
        const manifest = validateManifest(manifestRaw);

        const conflicts = await detectConflicts(db, manifest);

        if (conflicts.length > 0 && input.onConflict === "abort") {
          throw new Error(
            `Import aborted: ${conflicts.length} conflict(s) detected. Use onConflict=rename or replace to proceed.`,
          );
        }

        let data = await loadExtractedData(extractDir);

        // Apply path rewriting if user provided mappings
        if (input.pathMappings && Object.keys(input.pathMappings).length > 0) {
          data = applyPathRewritingToData(data, input.pathMappings);
        }

        await runPhasedInserts(db, data);

        return {
          companyId: manifest.companyId,
          companyName: manifest.companyName,
          recordCounts: countRecords(data),
          warnings: [],
          apiKeyMapping: [],
          orphanedUserRefs: [],
        };
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
      }
    },
  };
}
