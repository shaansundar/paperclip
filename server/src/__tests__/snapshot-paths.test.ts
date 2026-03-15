import { describe, expect, it } from "vitest";
import type { SnapshotPathEntry } from "@paperclipai/shared";
import { detectPaths, rewritePaths } from "../services/snapshot/paths.js";

describe("detectPaths", () => {
  it("detects workspaceDir in agent adapterConfig nested field", () => {
    const records = [
      {
        id: "agent-1",
        name: "My Agent",
        adapterConfig: { workspaceDir: "/home/user/projects/myapp" },
      },
    ];
    const result = detectPaths("agents", records, ["adapterConfig.workspaceDir"]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual<SnapshotPathEntry>({
      table: "agents",
      id: "agent-1",
      field: "adapterConfig.workspaceDir",
      value: "/home/user/projects/myapp",
    });
    expect(result.prefixes).toContain("/home/user/projects");
  });

  it("detects cwd in workspaces and deduplicates prefixes", () => {
    const records = [
      { id: "ws-1", cwd: "/home/user/projects/app" },
      { id: "ws-2", cwd: "/home/user/projects/backend" },
    ];
    const result = detectPaths("workspaces", records, ["cwd"]);

    expect(result.entries).toHaveLength(2);
    // Both paths share /home/user/projects as parent — deduplication should yield 1 prefix
    expect(result.prefixes).toHaveLength(1);
    expect(result.prefixes[0]).toBe("/home/user/projects");
  });

  it("skips null and undefined values", () => {
    const records = [
      { id: "agent-1", adapterConfig: { workspaceDir: null } },
      { id: "agent-2", adapterConfig: { workspaceDir: undefined } },
      { id: "agent-3", adapterConfig: null },
    ];
    const result = detectPaths("agents", records, ["adapterConfig.workspaceDir"]);

    expect(result.entries).toHaveLength(0);
    expect(result.prefixes).toHaveLength(0);
  });

  it("skips non-absolute paths and URLs", () => {
    const records = [
      { id: "ws-1", cwd: "relative/path" },
      { id: "ws-2", cwd: "https://example.com/repo" },
      { id: "ws-3", cwd: "" },
    ];
    const result = detectPaths("workspaces", records, ["cwd"]);

    expect(result.entries).toHaveLength(0);
    expect(result.prefixes).toHaveLength(0);
  });
});

describe("rewritePaths", () => {
  const entries: SnapshotPathEntry[] = [
    { table: "agents", id: "agent-1", field: "adapterConfig.workspaceDir", value: "/old/projects/app" },
    { table: "workspaces", id: "ws-1", field: "cwd", value: "/old/projects/backend" },
  ];

  it("applies prefix substitution to matching entries", () => {
    const records = [
      { id: "agent-1", adapterConfig: { workspaceDir: "/old/projects/app" } },
    ];
    const mappings = { "/old/projects": "/new/workspace" };

    const result = rewritePaths(records, entries, mappings);

    expect(result[0]).toMatchObject({
      id: "agent-1",
      adapterConfig: { workspaceDir: "/new/workspace/app" },
    });
  });

  it("does NOT mutate original data", () => {
    const records = [
      { id: "agent-1", adapterConfig: { workspaceDir: "/old/projects/app" } },
    ];
    const original = structuredClone(records);
    const mappings = { "/old/projects": "/new/workspace" };

    rewritePaths(records, entries, mappings);

    expect(records).toEqual(original);
  });

  it("handles multiple prefix mappings", () => {
    const records = [
      { id: "agent-1", adapterConfig: { workspaceDir: "/old/projects/app" } },
      { id: "ws-1", cwd: "/old/projects/backend" },
    ];
    const workspaceEntries: SnapshotPathEntry[] = [
      ...entries,
      { table: "workspaces", id: "ws-1", field: "cwd", value: "/old/projects/backend" },
    ];
    const mappings = { "/old/projects": "/new/workspace" };

    const result = rewritePaths(records, workspaceEntries, mappings);

    expect(result[0]).toMatchObject({ adapterConfig: { workspaceDir: "/new/workspace/app" } });
    expect(result[1]).toMatchObject({ cwd: "/new/workspace/backend" });
  });

  it("returns unmodified items when no mapping matches", () => {
    const records = [
      { id: "agent-1", adapterConfig: { workspaceDir: "/old/projects/app" } },
    ];
    const mappings = { "/completely/different": "/new/workspace" };

    const result = rewritePaths(records, entries, mappings);

    expect(result[0]).toMatchObject({ adapterConfig: { workspaceDir: "/old/projects/app" } });
  });
});
