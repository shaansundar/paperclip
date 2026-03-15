import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { createSnapshotExporter } from "../services/snapshot/export.js";
import { createSnapshotImporter } from "../services/snapshot/import.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "00000000-0000-0000-0000-000000000099";
const PASSPHRASE = "correctpassphrase123";
const WRONG_PASSPHRASE = "wrongpassphrase456";

const TEST_COMPANY = {
  id: COMPANY_ID,
  name: "Import Test Corp",
  status: "active",
  issuePrefix: "IMP",
};

const TEST_AGENTS = [
  {
    id: "agent-a",
    companyId: COMPANY_ID,
    name: "AgentAlpha",
    adapterConfig: { workspaceDir: "/home/user/alpha-workspace" },
    status: "idle",
    reportsTo: null,
  },
  {
    id: "agent-b",
    companyId: COMPANY_ID,
    name: "AgentBeta",
    adapterConfig: {},
    status: "idle",
    reportsTo: "agent-a",
  },
];

// ---------------------------------------------------------------------------
// Mock export DB (source data)
// ---------------------------------------------------------------------------

function createExportMockDb() {
  const tableData: Record<string, unknown[]> = {
    companies: [TEST_COMPANY],
    agents: TEST_AGENTS,
    agent_config_revisions: [],
    agent_api_keys: [],
    agent_runtime_state: [],
    agent_task_sessions: [],
    agent_wakeup_requests: [],
    goals: [
      { id: "goal-1", companyId: COMPANY_ID, title: "Grow revenue", parentId: null },
      { id: "goal-2", companyId: COMPANY_ID, title: "Sub-goal", parentId: "goal-1" },
    ],
    projects: [],
    project_workspaces: [
      { id: "ws-1", companyId: COMPANY_ID, projectId: "proj-1", cwd: "/home/user/project" },
    ],
    project_goals: [],
    workspace_runtime_services: [],
    issues: [
      {
        id: "issue-1",
        companyId: COMPANY_ID,
        title: "Bug fix",
        parentId: null,
        checkoutRunId: null,
        executionRunId: "run-1",
      },
    ],
    issue_comments: [],
    labels: [],
    issue_labels: [],
    issue_approvals: [],
    issue_read_states: [],
    issue_attachments: [],
    assets: [],
    heartbeat_runs: [
      { id: "run-1", companyId: COMPANY_ID, agentId: "agent-a", status: "ok" },
    ],
    heartbeat_run_events: [],
    cost_events: [],
    approvals: [],
    approval_comments: [],
    activity_log: [],
    company_secrets: [],
    company_secret_versions: [],
    company_memberships: [],
    principal_permission_grants: [],
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

  return { select };
}

// ---------------------------------------------------------------------------
// Tracking mock DB (target DB for import)
// ---------------------------------------------------------------------------

interface InsertRecord {
  tableName: string;
  data: unknown;
}

function createTrackingMockDb(conflictRows: Record<string, unknown[]> = {}) {
  const inserts: InsertRecord[] = [];
  const insertMap = new Map<string, unknown[]>();

  // For select queries (conflict detection)
  let currentTableName: string | null = null;

  const where = vi.fn(() => {
    const name = currentTableName ?? "";
    const rows = conflictRows[name] ?? [];
    return Promise.resolve(rows);
  });

  const from = vi.fn((table: object) => {
    currentTableName = getTableName(table as any);
    return { where };
  });

  const select = vi.fn(() => ({ from }));

  // For insert queries
  const returning = vi.fn(function (this: { _tableName: string; _data: unknown }) {
    return Promise.resolve([this._data]);
  });

  const values = vi.fn(function (this: { _tableName: string }, data: unknown) {
    const tableName = this._tableName;
    inserts.push({ tableName, data });
    const existing = insertMap.get(tableName) ?? [];
    if (Array.isArray(data)) {
      existing.push(...data);
    } else {
      existing.push(data);
    }
    insertMap.set(tableName, existing);
    return { returning: returning.bind({ _tableName: tableName, _data: data }) };
  });

  const insert = vi.fn((table: object) => {
    const tableName = getTableName(table as any);
    return { values: values.bind({ _tableName: tableName }) };
  });

  // Transaction support
  const transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    const txInserts: InsertRecord[] = [];

    const txReturning = vi.fn(function (this: { _tableName: string; _data: unknown }) {
      return Promise.resolve([this._data]);
    });

    const txValues = vi.fn(function (this: { _tableName: string }, data: unknown) {
      const tableName = this._tableName;
      txInserts.push({ tableName, data });
      inserts.push({ tableName, data });
      const existing = insertMap.get(tableName) ?? [];
      if (Array.isArray(data)) {
        existing.push(...data);
      } else {
        existing.push(data);
      }
      insertMap.set(tableName, existing);
      return { returning: txReturning.bind({ _tableName: tableName, _data: data }) };
    });

    const txInsert = vi.fn((table: object) => {
      const tableName = getTableName(table as any);
      return { values: txValues.bind({ _tableName: tableName }) };
    });

    const txSelect = vi.fn(() => ({ from }));

    const tx = {
      select: txSelect,
      insert: txInsert,
      _inserts: txInserts,
    };

    return fn(tx);
  });

  return {
    db: { select, insert, transaction },
    inserts,
    insertMap,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a real encrypted archive for testing
// ---------------------------------------------------------------------------

async function buildTestArchive(outputDir: string): Promise<string> {
  const exportDb = createExportMockDb();
  const exporter = createSnapshotExporter(exportDb);
  const result = await exporter.export({
    companyId: COMPANY_ID,
    passphrase: PASSPHRASE,
    history: "all",
    pauseAgents: false,
    outputDir,
  });
  return result.filePath;
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-import-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSnapshotImporter", () => {
  it("1. inspect returns manifest and detected paths from archive", async () => {
    const filePath = await buildTestArchive(tempDir);
    const { db } = createTrackingMockDb();
    const importer = createSnapshotImporter(db);

    const result = await importer.inspect({ filePath, passphrase: PASSPHRASE });

    expect(result.manifest).toBeDefined();
    expect(result.manifest.companyId).toBe(COMPANY_ID);
    expect(result.manifest.companyName).toBe(TEST_COMPANY.name);
    // Agents have absolute paths, so detectedPaths should be non-empty
    expect(Array.isArray(result.detectedPaths)).toBe(true);
    expect(result.detectedPaths.length).toBeGreaterThan(0);
    expect(result.conflicts).toBeDefined();
    expect(result.schemaCompatibility).toBeDefined();
  }, 30_000);

  it("2. inspect detects name conflict with existing company", async () => {
    const filePath = await buildTestArchive(tempDir);

    // Target DB already has a company with the same name
    const { db } = createTrackingMockDb({
      companies: [
        {
          id: "existing-company-id",
          name: TEST_COMPANY.name,
          issuePrefix: "XYZ",
        },
      ],
    });

    const importer = createSnapshotImporter(db);
    const result = await importer.inspect({ filePath, passphrase: PASSPHRASE });

    const nameConflict = result.conflicts.find((c) => c.type === "name");
    expect(nameConflict).toBeDefined();
    expect(nameConflict!.snapshotValue).toBe(TEST_COMPANY.name);
  }, 30_000);

  it("3. inspect fails with wrong passphrase", async () => {
    const filePath = await buildTestArchive(tempDir);
    const { db } = createTrackingMockDb();
    const importer = createSnapshotImporter(db);

    await expect(
      importer.inspect({ filePath, passphrase: WRONG_PASSPHRASE }),
    ).rejects.toThrow();
  }, 30_000);

  it("4. import inserts company and agents into target DB", async () => {
    const filePath = await buildTestArchive(tempDir);
    const { db, insertMap } = createTrackingMockDb();
    const importer = createSnapshotImporter(db);

    const result = await importer.import({ filePath, passphrase: PASSPHRASE });

    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.companyName).toBe(TEST_COMPANY.name);

    // Company must be inserted
    const companyInserts = insertMap.get("companies") ?? [];
    expect(companyInserts.length).toBeGreaterThan(0);

    // Agents must be inserted
    const agentInserts = insertMap.get("agents") ?? [];
    expect(agentInserts.length).toBeGreaterThan(0);
  }, 30_000);

  it("5. import applies path rewriting during import", async () => {
    const filePath = await buildTestArchive(tempDir);
    const { db, insertMap } = createTrackingMockDb();
    const importer = createSnapshotImporter(db);

    // Map the original workspace dir prefix to a new location
    const pathMappings = { "/home/user": "/new/user" };

    await importer.import({ filePath, passphrase: PASSPHRASE, pathMappings });

    // Agent inserts should have the rewritten path
    const agentInserts = (insertMap.get("agents") ?? []) as Array<Record<string, unknown>>;
    const agentWithPath = agentInserts.find((rows) => {
      // rows can be array (batch) or single record; normalize
      const items = Array.isArray(rows) ? rows : [rows];
      return items.some((item: any) => {
        const cfg = item?.adapterConfig;
        return typeof cfg === "object" && cfg !== null && typeof cfg.workspaceDir === "string"
          && cfg.workspaceDir.startsWith("/new/user");
      });
    });
    expect(agentWithPath).toBeDefined();
  }, 30_000);

  it("6. import cleans up temp directory after import", async () => {
    const filePath = await buildTestArchive(tempDir);
    const { db } = createTrackingMockDb();
    const importer = createSnapshotImporter(db);

    await importer.import({ filePath, passphrase: PASSPHRASE });

    // No paperclip-import-* temp dirs should remain in os.tmpdir()
    const tmpEntries = await fs.readdir(os.tmpdir());
    const leaked = tmpEntries.filter((e) => e.startsWith("paperclip-import-"));
    expect(leaked).toHaveLength(0);
  }, 30_000);
});
