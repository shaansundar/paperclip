import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { SnapshotImportResult, SnapshotInspectResult } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";

type ConflictMode = "abort" | "rename" | "replace";

interface ImportCommandOptions extends BaseClientOptions {
  file: string;
  passphraseStdin?: boolean;
  pathMap?: string;
  onConflict: ConflictMode;
  dryRun?: boolean;
}

async function readPassphraseFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let passphrase = "";
  for await (const line of rl) {
    passphrase = line.trim();
    break;
  }
  rl.close();
  return passphrase;
}

async function promptPassphrase(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const passphrase = await rl.question("Passphrase (min 12 chars): ");
  rl.close();
  return passphrase.trim();
}

function parsePathMap(input: string | undefined): Record<string, string> {
  if (!input?.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of input.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) {
      throw new Error(`Invalid --path-map entry '${pair}'. Expected format: old=new`);
    }
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid --path-map entry '${pair}'. Both old and new paths must be non-empty.`);
    }
    result[key] = value;
  }
  return result;
}

export const importCommand = new Command("import")
  .description("Import a company snapshot from an encrypted tar archive")
  .requiredOption("--file <path>", "Path to snapshot file (.tar.gz.enc)")
  .option("--passphrase-stdin", "Read passphrase from stdin instead of interactive prompt")
  .option("--path-map <mappings>", "Path remappings in old=new,old2=new2 format")
  .option("--on-conflict <mode>", "Conflict resolution: abort | rename | replace", "abort")
  .option("--dry-run", "Validate and inspect without applying import");

addCommonClientOptions(importCommand);

importCommand.action(async (opts: ImportCommandOptions) => {
  try {
    const passphrase = opts.passphraseStdin
      ? await readPassphraseFromStdin()
      : await promptPassphrase();

    if (passphrase.length < 12) {
      console.error(pc.red("Passphrase must be at least 12 characters."));
      process.exit(1);
    }

    const validConflictModes: ConflictMode[] = ["abort", "rename", "replace"];
    if (!validConflictModes.includes(opts.onConflict)) {
      console.error(pc.red(`Invalid --on-conflict value '${opts.onConflict}'. Use: abort, rename, replace`));
      process.exit(1);
    }

    const fileBuffer = await readFile(opts.file);
    const fileBase64 = fileBuffer.toString("base64");
    const pathMappings = parsePathMap(opts.pathMap);
    const ctx = resolveCommandContext(opts);

    const body = {
      fileBase64,
      passphrase,
      pathMappings,
      onConflict: opts.onConflict,
    };

    if (opts.dryRun) {
      const result = await ctx.api.post<SnapshotInspectResult>(
        "/api/companies/snapshot/inspect",
        body,
      );

      if (!result) {
        throw new Error("Inspect request returned no data");
      }

      if (ctx.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(pc.bold("Snapshot inspection (dry-run):"));
      console.log(`  company=${result.manifest.companyName}`);
      console.log(`  exportedAt=${result.manifest.exportedAt}`);
      console.log(`  schemaCompatibility=${result.schemaCompatibility}`);
      console.log(`  detectedPaths=${result.detectedPaths.length}`);
      if (result.conflicts.length === 0) {
        console.log(pc.green("  No conflicts detected."));
      } else {
        console.log(pc.yellow(`  Conflicts (${result.conflicts.length}):`));
        for (const conflict of result.conflicts) {
          console.log(`    type=${conflict.type} existing=${conflict.existingValue} snapshot=${conflict.snapshotValue}`);
        }
      }
      return;
    }

    const result = await ctx.api.post<SnapshotImportResult>(
      "/api/companies/snapshot/import",
      body,
    );

    if (!result) {
      throw new Error("Import request returned no data");
    }

    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(pc.green("Snapshot imported successfully."));
    console.log(`  company=${result.companyName}`);
    console.log(`  companyId=${result.companyId}`);
    const counts = Object.entries(result.recordCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    if (counts) {
      console.log(`  records: ${counts}`);
    }
    for (const warning of result.warnings) {
      console.log(pc.yellow(`  warning=${warning}`));
    }
    if (result.orphanedUserRefs.length > 0) {
      console.log(pc.yellow(`  orphanedUserRefs=${result.orphanedUserRefs.join(",")}`));
    }
    if (result.apiKeyMapping.length > 0) {
      console.log("  apiKeyMapping:");
      for (const entry of result.apiKeyMapping) {
        console.log(`    agentId=${entry.agentId} agentName=${entry.agentName} newKeyPrefix=${entry.newKeyPrefix}`);
      }
    }
  } catch (err) {
    handleCommandError(err);
  }
});
