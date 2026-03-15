import path from "node:path";
import type { SnapshotPathEntry } from "@paperclipai/shared";

/** Resolve a dot-notation field path against a record object. Returns undefined if any segment is missing/null. */
function getNestedValue(record: Record<string, unknown>, fieldPath: string): unknown {
  const segments = fieldPath.split(".");
  let current: unknown = record;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Set a value at a dot-notation field path on a (cloned) object. Returns the mutated clone. */
function setNestedValue(record: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const segments = fieldPath.split(".");
  let current: Record<string, unknown> = record;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];
    if (next === null || next === undefined || typeof next !== "object") {
      return;
    }
    current = next as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

/** Returns true if the value is an absolute filesystem path (Unix or Windows). Rejects URLs and relative paths. */
function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  // Reject URLs
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(value)) return false;
  // Unix absolute
  if (value.startsWith("/")) return true;
  // Windows absolute (e.g., C:\...)
  if (/^[A-Za-z]:\\/.test(value)) return true;
  return false;
}

export interface DetectPathsResult {
  entries: SnapshotPathEntry[];
  prefixes: string[];
}

/**
 * Walk all records in a table, resolve each fieldPath, collect entries where the value
 * is an absolute filesystem path, and extract deduplicated parent-directory prefixes.
 */
export function detectPaths(
  tableName: string,
  records: Array<Record<string, unknown>>,
  fieldPaths: string[],
): DetectPathsResult {
  const entries: SnapshotPathEntry[] = [];

  for (const record of records) {
    const id = String(record["id"] ?? "");
    for (const fieldPath of fieldPaths) {
      const value = getNestedValue(record, fieldPath);
      if (typeof value !== "string") continue;
      if (!isAbsolutePath(value)) continue;
      entries.push({ table: tableName, id, field: fieldPath, value });
    }
  }

  // Deduplicate parent directories
  const prefixSet = new Set<string>();
  for (const entry of entries) {
    prefixSet.add(path.dirname(entry.value));
  }

  return { entries, prefixes: Array.from(prefixSet) };
}

/**
 * Return a new array of records with path values rewritten according to mappings.
 * Never mutates the input array or its objects.
 */
export function rewritePaths<T extends Record<string, unknown>>(
  records: T[],
  entries: SnapshotPathEntry[],
  mappings: Record<string, string>,
): T[] {
  // Build a lookup: record id → list of entries for that record
  const entriesByRecordId = new Map<string, SnapshotPathEntry[]>();
  for (const entry of entries) {
    const list = entriesByRecordId.get(entry.id) ?? [];
    list.push(entry);
    entriesByRecordId.set(entry.id, list);
  }

  const sortedPrefixes = Object.keys(mappings).sort((a, b) => b.length - a.length);

  return records.map((record) => {
    const id = String(record["id"] ?? "");
    const relevantEntries = entriesByRecordId.get(id);
    if (!relevantEntries || relevantEntries.length === 0) return record;

    const clone = structuredClone(record) as T;

    for (const entry of relevantEntries) {
      const currentValue = getNestedValue(clone as Record<string, unknown>, entry.field);
      if (typeof currentValue !== "string") continue;

      // Find first matching prefix (longest-first ordering ensures specificity)
      for (const prefix of sortedPrefixes) {
        if (currentValue.startsWith(prefix)) {
          const replacement = mappings[prefix] + currentValue.slice(prefix.length);
          setNestedValue(clone as Record<string, unknown>, entry.field, replacement);
          break;
        }
      }
    }

    return clone;
  });
}
