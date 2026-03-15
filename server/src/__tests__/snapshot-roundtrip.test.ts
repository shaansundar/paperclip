import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { createSnapshotExporter } from "../services/snapshot/export.js";
import { createSnapshotImporter } from "../services/snapshot/import.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "00000000-0000-0000-0000-000000000042";
const PASSPHRASE = "roundtripassphrase789";

const TEST_COMPANY = {
  id: COMPANY_ID,
  name: "Roundtrip Corp",
  status: "active",
  issuePrefix: "RT",
};

const TEST_AGENTS = [
  {
    id: "agent-parent",
    companyId: COMPANY_ID,
    name: "ParentAgent",
    adapterConfig: { workspaceDir: "/home/roundtrip/parent-workspace" },
    status: "idle",
    reportsTo: null,
  },
  {
    id: "agent-child",
    companyId: COMPANY_ID,
    name: "ChildAgent",
    adapterConfig: { workspaceDir: "/home/roundtrip/child-workspace" },
    status: "idle",
    reportsTo: "agent-parent",
  },
];

// ---------------------------------------------------------------------------
// Export mock DB (source data)
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
    goals: [],
    projects: [],
    project_workspaces: [],
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
    heartbeat_runs: [
      { id: "run-rt1", companyId: COMPANY_ID, agentId: "agent-parent", status: "ok" },
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
// Temp dir — created once for the suite, cleaned up in afterAll
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-roundtrip-test-"));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Round-trip integration tests
// ---------------------------------------------------------------------------

describe("snapshot round-trip (export → import)", () => {
  it("1. export then import preserves company data and rewrites agent paths", async () => {
    // --- Export ---
    const exportDb = createExportMockDb();
    const exporter = createSnapshotExporter(exportDb);

    const exportResult = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "all",
      pauseAgents: false,
      outputDir: tempDir,
    });

    expect(exportResult.filePath).toBeTruthy();
    const stat = await fs.stat(exportResult.filePath);
    expect(stat.size).toBeGreaterThan(0);

    // --- Import with path rewriting ---
    const { db: importDb, insertMap } = createTrackingMockDb();
    const importer = createSnapshotImporter(importDb);

    const pathMappings = { "/home/roundtrip": "/new/home/roundtrip" };

    const importResult = await importer.import({
      filePath: exportResult.filePath,
      passphrase: PASSPHRASE,
      pathMappings,
    });

    // companyId is preserved through the round-trip
    expect(importResult.companyId).toBe(COMPANY_ID);
    expect(importResult.companyName).toBe(TEST_COMPANY.name);

    // Company was inserted into target DB
    const companyInserts = insertMap.get("companies") ?? [];
    expect(companyInserts.length).toBeGreaterThan(0);

    // Both agents were inserted (importer inserts without self-ref first, then re-inserts with reportsTo)
    const agentInserts = (insertMap.get("agents") ?? []) as Array<unknown>;
    expect(agentInserts.length).toBeGreaterThan(0);

    // Collect all individual agent records across all insert calls
    const allInsertedAgents: Array<Record<string, unknown>> = [];
    for (const batch of agentInserts) {
      const items = Array.isArray(batch) ? batch : [batch];
      allInsertedAgents.push(...(items as Array<Record<string, unknown>>));
    }

    // At least one agent with a rewritten workspaceDir
    const rewrittenAgent = allInsertedAgents.find((item) => {
      const cfg = item?.adapterConfig as Record<string, unknown> | undefined;
      return (
        typeof cfg === "object" &&
        cfg !== null &&
        typeof cfg.workspaceDir === "string" &&
        cfg.workspaceDir.startsWith("/new/home/roundtrip")
      );
    });
    expect(rewrittenAgent).toBeDefined();

    // Original paths must NOT appear in final inserted agents
    const unexpectedOriginalPath = allInsertedAgents.some((item) => {
      const cfg = item?.adapterConfig as Record<string, unknown> | undefined;
      return (
        typeof cfg === "object" &&
        cfg !== null &&
        typeof cfg.workspaceDir === "string" &&
        cfg.workspaceDir.startsWith("/home/roundtrip")
      );
    });
    // The self-ref re-insert will also carry rewritten paths, so original should be absent
    // (path rewriting happens before inserts)
    expect(unexpectedOriginalPath).toBe(false);
  }, 30_000);

  it("2. export with history=none skips execution tables (recordCounts are 0)", async () => {
    const exportDb = createExportMockDb();
    const exporter = createSnapshotExporter(exportDb);

    const exportResult = await exporter.export({
      companyId: COMPANY_ID,
      passphrase: PASSPHRASE,
      history: "none",
      pauseAgents: false,
      outputDir: tempDir,
    });

    const { recordCounts } = exportResult.manifest;

    // History tables must not appear (undefined) or be explicitly 0 when history=none
    // The exporter skips history tables entirely, so their keys are absent from recordCounts.
    const heartbeatRunsCount = recordCounts["heartbeatRuns"] ?? 0;
    const runEventsCount = recordCounts["heartbeatRunEvents"] ?? 0;
    const costEventsCount = recordCounts["costEvents"] ?? 0;

    expect(heartbeatRunsCount).toBe(0);
    expect(runEventsCount).toBe(0);
    expect(costEventsCount).toBe(0);

    // Core data (agents) should still be present
    expect(recordCounts["agents"]).toBe(TEST_AGENTS.length);
  }, 30_000);
});
