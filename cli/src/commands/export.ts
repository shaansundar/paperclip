import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { SnapshotExportResult } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";

interface ExportCommandOptions extends BaseClientOptions {
  company: string;
  output: string;
  passphraseStdin?: boolean;
  history: string;
  runsPerAgent?: number;
  pause: boolean;
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

export const exportCommand = new Command("export")
  .description("Export a company snapshot (encrypted tar archive)")
  .requiredOption("--company <nameOrId>", "Company name or ID")
  .option("--output <path>", "Output file path", "./snapshot.tar.gz.enc")
  .option("--passphrase-stdin", "Read passphrase from stdin instead of interactive prompt")
  .option("--history <window>", "History window (e.g. 30d, all, none)", "30d")
  .option("--runs-per-agent <n>", "Max heartbeat runs to include per agent", parseInt)
  .option("--no-pause", "Skip pausing agents before export");

addCommonClientOptions(exportCommand);

exportCommand.action(async (opts: ExportCommandOptions) => {
  try {
    const passphrase = opts.passphraseStdin
      ? await readPassphraseFromStdin()
      : await promptPassphrase();

    if (passphrase.length < 12) {
      console.error(pc.red("Passphrase must be at least 12 characters."));
      process.exit(1);
    }

    const ctx = resolveCommandContext(opts);

    const body = {
      passphrase,
      history: opts.history,
      runsPerAgent: opts.runsPerAgent ?? null,
      pauseAgents: opts.pause,
      outputPath: opts.output,
    };

    const result = await ctx.api.post<SnapshotExportResult>(
      `/api/companies/${encodeURIComponent(opts.company)}/snapshot/export`,
      body,
    );

    if (!result) {
      throw new Error("Export request returned no data");
    }

    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(pc.green("Snapshot exported successfully."));
    console.log(`  company=${result.manifest.companyName}`);
    console.log(`  file=${result.filePath}`);
    console.log(`  exportedAt=${result.manifest.exportedAt}`);
    const counts = Object.entries(result.manifest.recordCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    if (counts) {
      console.log(`  records: ${counts}`);
    }
    for (const warning of result.warnings) {
      console.log(pc.yellow(`  warning=${warning}`));
    }
  } catch (err) {
    handleCommandError(err);
  }
});
