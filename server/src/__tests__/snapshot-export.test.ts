import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { decryptBuffer, verifyIntegrity } from "../services/snapshot/encryption.js";
import { createSnapshotExporter } from "../services/snapshot/export.js";

// ---------------------------------------------------------------------------
// Minimal Drizzle-shaped DB mock
//
// The export service issues queries like:
//   db.select().from(table).where(eq(table.companyId, id))
// and for history tables with time windows:
//   db.select().from(table).where(and(eq(table.companyId, id), gte(table.createdAt, date)))
//
// We discriminate responses by getTableName(table) (Drizzle's runtime table name accessor).
// ---------------------------------------------------------------------------

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const PASSPHRASE = "supersecretpassphrase123";

const TEST_COMPANY = {
  id: COMPANY_ID,
  name: "Acme Corp",
  status: "active",
};

const TEST_AGENTS = [
  {
    id: "agent-1",
    companyId: COMPANY_ID,
    name: "Alpha",
    adapterConfig: { workspaceDir: "/home/user/workspace/alpha" },
    status: "idle",
  },
  {
    id: "agent-2",
    companyId: COMPANY_ID,
    name: "Beta",
    adapterConfig: {},
    status: "idle",
  },
];

const TEST_WORKSPACES = [
  {
    id: "ws-1",
    companyId: COMPANY_ID,
    projectId: "proj-1",
    name: "Main",
    cwd: "/home/user/workspace/main",
  },
];

const TEST_GOALS = [
  { id: "goal-1", companyId: COMPANY_ID, title: "Ship v2" },
  { id: "goal-2", companyId: COMPANY_ID, title: "Improve CI" },
  { id: "goal-3", companyId: COMPANY_ID, title: "Reduce costs" },
];

const TEST_HEARTBEAT_RUNS = [
  { id: "run-1", companyId: COMPANY_ID, agentId: "agent-1", status: "ok" },
];

/**
 * Build a mock DB object that responds to the Drizzle builder pattern.
 * fromTable is set by `from()` and used by `where()` to pick the response.
 */
function createMockDb(overrides: Record<string, unknown[]> = {}) {
  const tableData: Record<string, unknown[]> = {
    companies: [TEST_COMPANY],
    agents: TEST_AGENTS,
    agent_config_revisions: [],
    agent_api_keys: [],
    agent_runtime_state: [],
    agent_task_sessions: [],
    agent_wakeup_requests: [],
    goals: TEST_GOALS,
    projects: [],
    project_workspaces: TEST_WORKSPACES,
    project_goals: [],
    workspace_runtime_services: [],
    issues: [],
    issue_comments: [],
    labels: [],
    issue_labels: [],
    issue_approvals: [],
    issue_read_states: [],
    issue_attachments: [],
    assets: [],
    heartbeat_runs: TEST_HEARTBEAT_RUNS,
    heartbeat_run_events: [],
    cost_events: [],
    approvals: [],
    approval_comments: [],
    activity_log: [],
    company_secrets: [],
    company_secret_versions: [],
    company_memberships: [],
    principal_permission_grants: [],
    ...overrides,
  };

  let currentTableName: string | null = null;

  const where = vi.fn(() => {
    const name = currentTableName ?? "";
    return Promise.resolve(tableData[name] ?? []);
  });

  const from = vi.fn((table: object) => {
    currentTableName = getTableName(table as any);
    return { where };
  });

  const select = vi.fn(() => ({ from }));

  return { db: { select }, tableData };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tempOutputDir: string;

beforeEach(async () => {
  tempOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-test-"));
});

afterEach(async () => {
  await fs.rm(tempOutputDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("createSnapshotExporter", () => {
  it("1. exports a valid encrypted archive that can be decrypted and is integrity-verified", async () => {
    const { db } = createMockDb();
    const exporter = createSnapshotExporter(db);

    const result = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "all",
      pauseAgents: false,
      outputDir: tempOutputDir,
    });

    // File must exist
    const stat = await fs.stat(result.filePath);
    expect(stat.size).toBeGreaterThan(0);

    // The file must be a valid encrypted archive (integrity check via HMAC)
    const encrypted = await fs.readFile(result.filePath);
    expect(verifyIntegrity(encrypted)).toBe(true);

    // Must decrypt without throwing
    const decrypted = await decryptBuffer(encrypted, PASSPHRASE);
    expect(decrypted.length).toBeGreaterThan(0);
  }, 30_000);

  it("2. archive contains all required JSON files", async () => {
    const { db } = createMockDb();
    const exporter = createSnapshotExporter(db);

    const result = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "all",
      pauseAgents: false,
      outputDir: tempOutputDir,
    });

    // Decrypt the archive
    const encrypted = await fs.readFile(result.filePath);
    const tarGzBuffer = await decryptBuffer(encrypted, PASSPHRASE);

    // Write tar.gz to temp dir and extract to verify contents
    const tarPath = path.join(tempOutputDir, "check.tar.gz");
    await fs.writeFile(tarPath, tarGzBuffer);

    const extractDir = path.join(tempOutputDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    const { extract: tarExtract } = await import("tar");
    await tarExtract({ file: tarPath, cwd: extractDir });

    // Required files
    const required = [
      "manifest.json",
      "company.json",
      "agents/agents.json",
      "goals/goals.json",
    ];

    for (const rel of required) {
      const fullPath = path.join(extractDir, rel);
      const exists = await fs.stat(fullPath).then(() => true).catch(() => false);
      expect(exists, `Expected ${rel} to exist in archive`).toBe(true);
    }
  }, 30_000);

  it("3. manifest recordCounts match actual data counts", async () => {
    const { db } = createMockDb();
    const exporter = createSnapshotExporter(db);

    const result = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "all",
      pauseAgents: false,
      outputDir: tempOutputDir,
    });

    // agents = 2, goals = 3
    expect(result.manifest.recordCounts["agents"]).toBe(TEST_AGENTS.length);
    expect(result.manifest.recordCounts["goals"]).toBe(TEST_GOALS.length);
    expect(result.manifest.companyId).toBe(COMPANY_ID);
    expect(result.manifest.companyName).toBe(TEST_COMPANY.name);
  }, 30_000);

  it("4. detects absolute paths and writes path_mappings.json", async () => {
    const { db } = createMockDb();
    const exporter = createSnapshotExporter(db);

    const result = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "all",
      pauseAgents: false,
      outputDir: tempOutputDir,
    });

    // Decrypt and extract
    const encrypted = await fs.readFile(result.filePath);
    const tarGzBuffer = await decryptBuffer(encrypted, PASSPHRASE);

    const tarPath = path.join(tempOutputDir, "check2.tar.gz");
    await fs.writeFile(tarPath, tarGzBuffer);

    const extractDir = path.join(tempOutputDir, "extracted2");
    await fs.mkdir(extractDir, { recursive: true });

    const { extract: tarExtract } = await import("tar");
    await tarExtract({ file: tarPath, cwd: extractDir });

    // path_mappings.json must exist since we have agents with absolute paths
    const mappingsPath = path.join(extractDir, "path_mappings.json");
    const exists = await fs.stat(mappingsPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = JSON.parse(await fs.readFile(mappingsPath, "utf-8"));
    // Should have entries — at least one from agent-1 and ws-1
    expect(Array.isArray(content.entries)).toBe(true);
    expect(content.entries.length).toBeGreaterThan(0);
  }, 30_000);

  it("5. cleans up temp directory even on error", async () => {
    // Create a DB that throws on select so the export fails mid-way
    const brokenSelect = vi.fn(() => {
      throw new Error("DB connection lost");
    });
    const brokenDb = { select: brokenSelect };
    const exporter = createSnapshotExporter(brokenDb);

    await expect(
      exporter.export({
        companyId: COMPANY_ID,
        passphrase: PASSPHRASE,
        history: "all",
        pauseAgents: false,
        outputDir: tempOutputDir,
      })
    ).rejects.toThrow();

    // Temp dir used internally by exporter must be cleaned up.
    // We verify by checking no subdirectories were left in the OS tmp dir.
    // (The exporter uses mkdtemp internally, which creates dirs in os.tmpdir())
    const tmpEntries = await fs.readdir(os.tmpdir());
    const leaked = tmpEntries.filter((e) => e.startsWith("paperclip-snapshot-"));
    expect(leaked).toHaveLength(0);
  }, 30_000);
});
