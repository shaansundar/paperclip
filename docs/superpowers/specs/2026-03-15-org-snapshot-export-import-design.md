# Organization Snapshot Export/Import

**Date:** 2026-03-15
**Status:** Draft
**Use Cases:** Device migration, Backup/restore

## Overview

Export and import the complete running state of a Paperclip organization as a single encrypted archive file. The archive preserves all configuration, agent state, work history, secrets, and governance data — enabling 100% replication on a new device.

## Design Decisions

| Concern | Decision |
|---|---|
| Use cases | Device migration + Backup/restore |
| Secrets | Plaintext in archive, entire bundle passphrase-encrypted (AES-256-GCM + Argon2id) |
| Paths | Prefix-based rewrite on import |
| History | Configurable window (default 30 days) |
| Format | Tar archive (`.tar.gz.enc`) |
| Surfaces | CLI + UI + REST API |
| Consistency | Optional agent pause during export |
| Conflict | Abort / rename / replace modes |
| Integrity | SHA-256 checksums + record counts + FK validation |

## Archive Structure

```
paperclip-snapshot-{companySlug}-{timestamp}.tar.gz
├── manifest.json                    # Version, export date, source device, schema version, options
├── company.json                     # Company record
├── agents/
│   ├── agents.json                  # All agent records
│   ├── runtime_state.json           # Agent runtime state (session persistence)
│   ├── task_sessions.json           # Agent task sessions
│   ├── config_revisions.json        # Immutable config change history
│   └── api_keys.json                # Agent API key metadata only (keys re-generated on import)
├── goals/
│   └── goals.json                   # Hierarchical goal tree
├── projects/
│   ├── projects.json                # Project records
│   └── workspaces.json              # Project workspaces (paths subject to rewriting)
├── issues/
│   ├── issues.json                  # All issues
│   ├── comments.json                # Issue comments
│   ├── labels.json                  # Labels + issue_labels join
│   ├── attachments.json             # Attachment metadata
│   └── read_states.json             # Issue read states
├── execution/
│   ├── heartbeat_runs.json          # Filtered by configurable window
│   ├── run_events.json              # Events for included runs only (IDs regenerated on import)
│   ├── wakeup_requests.json         # Pending + recent wakeup requests
│   ├── cost_events.json             # Filtered by companyId + occurredAt within history window
│   └── workspace_runtime_services.json  # Runtime service configs (paths subject to rewriting)
├── governance/
│   ├── approvals.json               # Approvals + approval comments
│   ├── issue_approvals.json         # Issue-to-approval join records
│   ├── memberships.json             # Company memberships (note: user refs may be orphaned)
│   └── permissions.json             # Permission grants (note: user refs may be orphaned)
├── secrets/
│   └── secrets.json                 # Decrypted secrets (bundle is passphrase-encrypted)
├── activity_log.json                # Audit trail (filtered by window)
├── assets/                          # Binary blobs (log files, attachments)
│   ├── {asset-id-1}.bin
│   └── ...
└── path_mappings.json               # Records original paths for rewrite on import
```

## Manifest Schema

```json
{
  "version": 1,
  "paperclipVersion": "0.x.y",
  "schemaVersion": "0042_migration_name",
  "exportedAt": "2026-03-15T10:30:00Z",
  "sourceHostname": "sundar-macbook",
  "sourcePlatform": "darwin-arm64",
  "companyId": "uuid",
  "companyName": "Acme AI Corp",
  "options": {
    "historyWindow": "30d",
    "runsPerAgent": null,
    "agentsPaused": true
  },
  "recordCounts": {
    "agents": 12,
    "goals": 8,
    "projects": 3,
    "issues": 145,
    "heartbeatRuns": 892,
    "costEvents": 2340
  },
  "checksums": {
    "company.json": "sha256:abc123...",
    "agents/agents.json": "sha256:def456..."
  },
  "assetsIncomplete": false,
  "consistentSnapshot": true
}
```

## Export Pipeline

### Steps

1. **Validate & lock** — Verify company exists. Optionally pause all agents for consistent snapshot (user can skip with `--no-pause`).

2. **Build manifest** — Record schema version (from latest migration), export timestamp, source hostname, Paperclip version, export options.

3. **Extract data** — Query each table filtered by `companyId`, ordered by dependency:
   - company → agents → goals → projects → workspaces → issues → labels → comments → attachments
   - execution: heartbeat_runs → run_events → wakeup_requests → workspace_runtime_services
   - cost_events: filtered by `companyId` + `occurredAt` timestamp (not by run ID, as no FK exists)
   - governance: approvals → memberships → permissions
   - state: agent_runtime_state → agent_task_sessions → agent_config_revisions
   - activity_log
   Stream each result set to temp directory as JSON files.

4. **Collect paths** — Scan extracted JSON for absolute paths in known fields:
   - `agents[].adapterConfig.workspaceDir`
   - `agents[].adapterConfig.cwd`
   - `projects[].executionWorkspacePolicy` path fields
   - `workspaces[].cwd`
   - `workspaces[].repoUrl` (if local path)
   - `workspace_runtime_services[].cwd`

   Write to `path_mappings.json`:
   ```json
   {
     "detectedPrefixes": ["/Users/notthatsundar/Code"],
     "pathEntries": [
       {
         "table": "agents",
         "id": "abc123",
         "field": "adapterConfig.workspaceDir",
         "value": "/Users/notthatsundar/Code/acme"
       }
     ]
   }
   ```

5. **Export secrets** — Decrypt all company secrets using the current `.secrets.key`. Include plaintext values in `secrets.json`.

6. **Copy assets** — Copy referenced log blobs and attachments into `assets/` directory.

7. **Bundle** — Tar the temp directory, gzip compress.

8. **Encrypt** — Encrypt the tar.gz with user-provided passphrase:
   - Key derivation: Argon2id (memory=64MB, iterations=3, parallelism=1)
   - Cipher: AES-256-GCM
   - Random 16-byte salt + 12-byte nonce stored as plaintext header
   - Each archive uses a unique salt, so each derived key is unique (no GCM nonce reuse risk)
   - Output: `.paperclip-snapshot.tar.gz.enc`

9. **Resume agents** — If paused in step 1, resume them.

10. **Cleanup** — Remove temp directory.

**Critical: Steps 5-10 are wrapped in a try/finally block.** The finally block guarantees temp directory deletion even on crash, preventing plaintext secrets from remaining on disk. Secrets are never written to an unencrypted file outside the temp directory.

### History Filtering (Step 3)

| Flag | Behavior |
|---|---|
| `--history=all` | Export all execution history |
| `--history=30d` (default) | Last 30 days of runs/events/costs |
| `--history=none` | Current state only, skip execution tables |
| `--runs-per-agent=N` | Last N runs per agent regardless of date |

## Import Pipeline

### Steps

1. **Decrypt** — Prompt for passphrase, derive key (Argon2id with salt from file header), decrypt to tar.gz.

2. **Extract** — Untar to temp directory, read `manifest.json`.

3. **Schema compatibility check**:
   - Target schema older than snapshot → Hard abort: "Upgrade Paperclip first."
   - Target schema newer than snapshot → Proceed (migrations only add columns/tables, defaults fill gaps).
   - Same version → Proceed normally.

4. **Path rewriting** — Read `path_mappings.json`, present detected prefixes:
   ```
   Detected paths with prefix: /Users/notthatsundar/Code
   Enter replacement prefix: /Users/jane/projects
   ```
   Apply prefix substitution across all JSON files.

5. **Conflict resolution** — Check target DB for existing company:
   - No conflict → Insert normally.
   - Name conflict, different ID → Prompt to rename or merge.
   - `issuePrefix` conflict → Auto-generate unique prefix (append numeric suffix) or prompt user.
   - Same ID (re-import/restore) → Offer wipe-and-replace (requires confirmation).
   - `issueCounter` handling: On replace, set to `MAX(source.issueCounter, target.issueCounter)` to prevent identifier collisions.
   - `issues.identifier` collision: On replace mode, existing identifiers are wiped first. On rename/new-company mode, regenerate identifiers using the target company's `issuePrefix` + counter.

6. **Insert data** — Per-phase transactions with rollback-all on failure (avoids long-held locks for large datasets):
   - Phase 1: company, agents (with `reportsTo = null`), goals (with `parentId = null`), projects
   - Phase 2: Update self-referential FKs (agent `reportsTo`, goal `parentId`)
   - Phase 3: workspaces, labels, project_goals
   - Phase 4: heartbeat_runs (needed before issues due to `checkoutRunId`/`executionRunId` FKs)
   - Phase 5: issues (with `parentId = null`), then update issue `parentId` self-references. Also insert issue_comments, issue_labels, issue_attachments, issue_read_states
   - Phase 6: run_events (IDs regenerated by DB `bigserial`, ordered by `seq` within each run), wakeup_requests, workspace_runtime_services
   - Phase 7: cost_events (depends on agents, issues, projects, goals from earlier phases)
   - Phase 8: governance — approvals, approval_comments, issue_approvals, memberships, permissions
   - Phase 9: agent state (runtime_state, task_sessions, config_revisions)
   - Phase 10: activity_log (entries referencing excluded heartbeat_runs get `runId = null`)

   On failure in any phase, all previously committed phases are rolled back via a cleanup procedure that deletes all inserted records by company ID.

   After all phases complete, reset `bigserial` sequences to `MAX(existing, imported) + 1` for `heartbeat_run_events`.

7. **Re-encrypt secrets** — Encrypt plaintext secrets with target instance's `.secrets.key`. If no key exists, generate one. Insert into `company_secrets` + `company_secret_versions`.

8. **Regenerate API keys** — Generate new JWT-based agent API keys. Log old → new mapping for user reference.

9. **Restore assets** — Copy blobs from `assets/` to target storage provider (local_disk or S3).

10. **Validation** — Integrity checks:
    - Record counts per table vs manifest counts
    - FK references all resolve
    - Referenced assets exist in storage
    - Agent runtime state is consistent

11. **Cleanup** — Remove temp directory. Print summary with record counts, warnings, and new API key mapping.

## CLI Interface

```bash
# Export
paperclip export \
  --company <name-or-id> \
  --output ./my-snapshot.tar.gz.enc \
  --passphrase-stdin              # or interactive prompt
  --history 30d                   # all | none | Nd (default: 30d)
  --runs-per-agent 50             # optional cap per agent
  --no-pause                      # skip pausing agents during export

# Import
paperclip import \
  --file ./my-snapshot.tar.gz.enc \
  --passphrase-stdin \
  --path-map "/Users/old/Code=/Users/new/projects"  # or interactive
  --on-conflict replace           # replace | rename | abort (default: abort)
  --dry-run                       # validate only, don't write

# Inspect (without importing)
paperclip snapshot inspect ./my-snapshot.tar.gz.enc \
  --passphrase-stdin
  # Prints: company name, agent count, issue count, history range,
  #         file size breakdown, detected paths, schema version
```

## UI Interface

### Company Settings — Snapshot Section

**Export:**
- Button opens modal with:
  - History window dropdown (30 days / 90 days / all / none)
  - Passphrase input (required, with confirmation field)
  - "Pause agents during export" toggle (default: on)
  - Progress bar showing current step
  - Auto-downloads file on completion

**Import:**
- File upload dropzone + passphrase input
- Preview step (like `inspect`): shows company name, record counts, detected paths, schema compatibility
- Path mapping table: detected prefix → replacement input field
- Conflict resolution radio: abort / rename / replace
- Progress bar with per-table status
- Summary on completion: record counts, warnings, new API keys

## API Endpoints

```
POST /api/companies/:id/export
  Body: { passphrase, history, runsPerAgent, pauseAgents }
  Response: Streaming binary (application/octet-stream)

POST /api/companies/import
  Body: Multipart form (file + JSON options: passphrase, pathMappings, onConflict)
  Response: { companyId, recordCounts, warnings, apiKeyMapping }

POST /api/companies/import/inspect
  Body: Multipart form (file + passphrase)
  Response: { manifest, detectedPaths, schemaCompatibility, conflicts }
```

### Progress Tracking

For large exports/imports, the UI progress bar is driven by Server-Sent Events (SSE):

```
GET /api/companies/:id/export/progress?jobId=xxx
GET /api/companies/import/progress?jobId=xxx
  Response: SSE stream with { phase, table, recordsProcessed, totalRecords }
```

The export/import endpoints return a `jobId` immediately, and the actual work runs asynchronously. The CLI polls the progress endpoint internally to display a progress bar.

## Error Handling

### Export Failures

| Scenario | Behavior |
|---|---|
| DB connection lost mid-export | Clean up temp dir, return error with last successful table |
| Storage provider unreachable | Export with `assetsIncomplete: true` in manifest, list missing asset IDs |
| Agent refuses to pause | Export with `consistentSnapshot: false` warning |

### Import Failures

| Scenario | Behavior |
|---|---|
| Wrong passphrase | Fail fast on decryption, clear error message |
| Schema newer than target | Hard abort: "Upgrade Paperclip first" |
| Schema older than target | Proceed, missing columns get migration defaults |
| FK violation | Transaction rollback, report failing record/table |
| Path mapping incomplete | Warning with unresolved paths list, import succeeds |
| Disk space insufficient | Check before extracting, fail early |
| Duplicate company name | Follow `--on-conflict` flag |

### Data Integrity

- SHA-256 checksums per JSON file and per asset blob in manifest
- Import verifies checksums before inserting
- Record counts in manifest vs actual compared post-import
- Circular FK references handled via two-phase insert (nulls first, then update)

### Secrets Edge Cases

- Target has no `.secrets.key` → Generate one automatically
- Secret name collision with different company → Error
- Secret name collision with same company (replace mode) → Overwrite

## Security

### Archive Encryption

- AES-256-GCM, key derived from passphrase via Argon2id (memory=64MB, iterations=3, parallelism=1)
- Random 16-byte salt + 12-byte nonce as plaintext header in `.enc` file
- Encryption on raw tar.gz — no plaintext written to disk outside temp dir
- Temp directory uses `0700` permissions, wiped on cleanup

### Passphrase Requirements

- Minimum 12 characters enforced by default
- Override with `--force` flag for automation scenarios
- UI shows strength indicator

### Archive Integrity

- The `.enc` file includes a trailing HMAC-SHA256 over the ciphertext, verifiable before decryption
- Allows detecting corruption during file transfer without needing the passphrase

### Secrets in Transit

- Decrypted from source DB → exist plaintext only in memory and inside encrypted archive
- Never written to unencrypted file on disk
- Export API streams encrypted archive directly

### Access Control

- Export/import require company admin role
- Import with `--on-conflict replace` requires instance admin
- Rate-limited: 1 concurrent export/import per company
- Max upload size: configurable (default 2GB)

### Audit Trail

- Export: activity log entry with who, when, options
- Import: activity log entry with who, source manifest metadata, record counts, path mappings

## Tables Included in Export

### Core Organization
- `companies` (single record)
- `agents`
- `goals`
- `projects`, `project_workspaces`
- `project_goals`

### Work & Execution
- `issues`, `issue_comments`
- `labels`, `issue_labels`
- `issue_attachments`, `assets`
- `issue_read_states`
- `heartbeat_runs`, `heartbeat_run_events`
- `agent_wakeup_requests`
- `approvals`, `approval_comments`

### Agent State
- `agent_runtime_state`
- `agent_task_sessions`
- `agent_config_revisions`
- `agent_api_keys`

### Tracking & Audit
- `cost_events`
- `activity_log`

### Configuration & Secrets
- `company_secrets`, `company_secret_versions`
- `workspace_runtime_services`

### Access Control
- `company_memberships`
- `principal_permission_grants`

### Work & Execution (continued)
- `issue_approvals`

### Execution & Services
- `workspace_runtime_services`

### Excluded (Instance-Level)
- `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications` — these belong to the instance, not the company
- `instance_user_roles` — instance-level
- `invites`, `join_requests` — ephemeral, tied to instance auth

## Relationship to Existing Portability Service

The codebase has an existing `company-portability.ts` service that handles markdown-based agent import/export with slug collision resolution. This snapshot feature is a **complementary capability**, not a replacement:

- **Existing service:** Lightweight agent-level import/export via markdown frontmatter. Used for adding/copying individual agents between companies.
- **This feature:** Full organization-level snapshot for device migration and backup/restore. Captures complete state including execution history, secrets, governance, and configuration.

Where applicable, collision resolution logic from `company-portability.ts` should be reused rather than duplicated.

## Archive Format Versioning

The manifest `"version"` field tracks archive format versions:

- **Forward compatibility:** Older Paperclip versions encountering a newer archive version abort with "Upgrade Paperclip to import this snapshot."
- **Backward compatibility:** Newer Paperclip versions can import older archive versions. Missing files/fields use defaults. The import code maintains a version-specific adapter layer.
- **Version bumps:** Triggered by structural changes (new top-level directories, changed manifest schema, new encryption scheme). Adding new JSON files within existing directories does NOT require a version bump — importers ignore unknown files.

## Orphaned User References

`company_memberships` and `principal_permission_grants` may reference `auth_users` IDs that don't exist on the target instance (since auth tables are instance-level and excluded from export).

On import:
- Memberships/permissions referencing non-existent user IDs are imported but flagged in the summary as "orphaned user references."
- The importing user is automatically added as a company admin if not already present.
- Other user references can be resolved post-import by inviting users to the company on the target instance.

## TDD Implementation Approach

Development follows RED-GREEN-REFACTOR:

1. **Write tests first** for each module (export service, import service, encryption, path rewriting, CLI commands)
2. **Run tests — they fail** (RED)
3. **Write minimal implementation** to pass tests (GREEN)
4. **Refactor** while keeping tests green (REFACTOR)
5. **Verify 80%+ coverage**

Test categories:
- **Unit tests:** Encryption/decryption, path detection/rewriting, manifest generation/validation, schema compatibility checks, conflict detection
- **Integration tests:** Full export → import round-trip with test DB, API endpoints, CLI commands
- **Edge case tests:** Circular FKs, missing assets, wrong passphrase, schema version mismatch, large datasets
