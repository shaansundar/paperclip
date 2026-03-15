import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { SnapshotInspectResult } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";

interface SnapshotInspectCommandOptions extends BaseClientOptions {
  file: string;
  passphraseStdin?: boolean;
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

const snapshotInspectSubcommand = new Command("inspect")
  .description("Inspect a snapshot archive: show manifest, detected paths, and conflicts")
  .requiredOption("--file <path>", "Path to snapshot file (.tar.gz.enc)")
  .option("--passphrase-stdin", "Read passphrase from stdin instead of interactive prompt");

addCommonClientOptions(snapshotInspectSubcommand);

snapshotInspectSubcommand.action(async (opts: SnapshotInspectCommandOptions) => {
  try {
    const passphrase = opts.passphraseStdin
      ? await readPassphraseFromStdin()
      : await promptPassphrase();

    if (passphrase.length < 12) {
      console.error(pc.red("Passphrase must be at least 12 characters."));
      process.exit(1);
    }

    const fileBuffer = await readFile(opts.file);
    const fileBase64 = fileBuffer.toString("base64");
    const ctx = resolveCommandContext(opts);

    const body = { fileBase64, passphrase };

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

    console.log(pc.bold("Snapshot manifest:"));
    console.log(`  company=${result.manifest.companyName} (${result.manifest.companyId})`);
    console.log(`  exportedAt=${result.manifest.exportedAt}`);
    console.log(`  paperclipVersion=${result.manifest.paperclipVersion}`);
    console.log(`  schemaVersion=${result.manifest.schemaVersion}`);
    console.log(`  schemaCompatibility=${result.schemaCompatibility}`);
    console.log(`  consistentSnapshot=${result.manifest.consistentSnapshot}`);
    console.log(`  assetsIncomplete=${result.manifest.assetsIncomplete}`);

    const counts = Object.entries(result.manifest.recordCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    if (counts) {
      console.log(`  records: ${counts}`);
    }

    if (result.detectedPaths.length > 0) {
      console.log(pc.bold(`\nDetected paths (${result.detectedPaths.length}):`));
      for (const entry of result.detectedPaths) {
        console.log(`  table=${entry.table} id=${entry.id} field=${entry.field} value=${entry.value}`);
      }
    } else {
      console.log("\n  No path references detected.");
    }

    if (result.conflicts.length === 0) {
      console.log(pc.green("\n  No conflicts detected."));
    } else {
      console.log(pc.yellow(`\nConflicts (${result.conflicts.length}):`));
      for (const conflict of result.conflicts) {
        console.log(`  type=${conflict.type} existing=${conflict.existingValue} snapshot=${conflict.snapshotValue}`);
      }
    }
  } catch (err) {
    handleCommandError(err);
  }
});

export const snapshotInspectCommand = new Command("snapshot")
  .description("Snapshot utilities")
  .addCommand(snapshotInspectSubcommand);
