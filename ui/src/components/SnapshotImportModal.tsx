import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { companiesApi } from "../api/companies";
import type {
  CompanyPortabilityPreviewResult,
  CompanyPortabilityImportResult,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityManifest,
} from "@paperclipai/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Step = "upload" | "preview" | "import";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SnapshotImportModal({ open, onClose }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [collisionStrategy, setCollisionStrategy] =
    useState<CompanyPortabilityCollisionStrategy>("rename");
  const [preview, setPreview] = useState<CompanyPortabilityPreviewResult | null>(null);
  const [importResult, setImportResult] = useState<CompanyPortabilityImportResult | null>(null);
  const [parsedManifest, setParsedManifest] = useState<CompanyPortabilityManifest | null>(null);
  const [parsedFiles, setParsedFiles] = useState<Record<string, string> | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleClose() {
    setStep("upload");
    setFile(null);
    setPassphrase("");
    setCollisionStrategy("rename");
    setPreview(null);
    setImportResult(null);
    setParsedManifest(null);
    setParsedFiles(null);
    setParseError(null);
    previewMutation.reset();
    importMutation.reset();
    onClose();
  }

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!parsedManifest || !parsedFiles) {
        throw new Error("No valid snapshot file loaded.");
      }
      return companiesApi.importPreview({
        source: { type: "inline", manifest: parsedManifest, files: parsedFiles },
        target: { mode: "new_company" },
        collisionStrategy,
      });
    },
    onSuccess: (result) => {
      setPreview(result);
      setStep("preview");
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!parsedManifest || !parsedFiles) {
        throw new Error("No valid snapshot file loaded.");
      }
      return companiesApi.importBundle({
        source: { type: "inline", manifest: parsedManifest, files: parsedFiles },
        target: { mode: "new_company" },
        collisionStrategy,
      });
    },
    onSuccess: (result) => {
      setImportResult(result);
      setStep("import");
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setParseError(null);
    setParsedManifest(null);
    setParsedFiles(null);

    if (!selected) return;

    try {
      const text = await selected.text();
      const parsed = JSON.parse(text) as { manifest?: unknown; files?: unknown };
      if (!parsed.manifest || typeof parsed.manifest !== "object") {
        setParseError("Invalid snapshot file: missing manifest.");
        return;
      }
      setParsedManifest(parsed.manifest as CompanyPortabilityManifest);
      setParsedFiles((parsed.files as Record<string, string>) ?? {});
    } catch {
      setParseError("Could not parse snapshot file. Ensure it is a valid JSON export.");
    }
  }

  const sourceCompanyName =
    parsedManifest?.source?.companyName ?? preview?.targetCompanyName ?? "Unknown";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Snapshot</DialogTitle>
          <DialogDescription>
            {step === "upload" && "Upload a snapshot file to preview and import."}
            {step === "preview" && `Preview for "${sourceCompanyName}".`}
            {step === "import" && "Import complete."}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Upload */}
        {step === "upload" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="snapshot-file">Snapshot file</Label>
              <input
                id="snapshot-file"
                ref={fileInputRef}
                type="file"
                accept=".json,.enc,.gz"
                onChange={handleFileChange}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-0.5 file:text-xs file:font-medium"
              />
              {parseError && (
                <p className="text-xs text-destructive">{parseError}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="import-passphrase">
                Passphrase{" "}
                <span className="text-xs font-normal text-muted-foreground">(if encrypted)</span>
              </Label>
              <input
                id="import-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Leave empty if not encrypted"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {previewMutation.isError && (
              <p className="text-sm text-destructive">
                {previewMutation.error instanceof Error
                  ? previewMutation.error.message
                  : "Preview failed."}
              </p>
            )}
          </div>
        )}

        {/* Step 2: Preview */}
        {step === "preview" && preview && (
          <div className="space-y-4">
            <div className="rounded-md border border-border px-3 py-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Source company</span>
                <span className="text-sm font-medium">{sourceCompanyName}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Company action</span>
                <span className="text-xs rounded-full border border-border px-2 py-0.5 capitalize">
                  {preview.plan.companyAction}
                </span>
              </div>
              {preview.errors.length > 0 && (
                <div className="space-y-0.5 pt-1">
                  {preview.errors.map((err, i) => (
                    <p key={i} className="text-xs text-destructive">{err}</p>
                  ))}
                </div>
              )}
              {preview.warnings.length > 0 && (
                <div className="space-y-0.5 pt-1">
                  {preview.warnings.map((warn, i) => (
                    <p key={i} className="text-xs text-amber-600 dark:text-amber-400">{warn}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Agent plans table */}
            {preview.plan.agentPlans.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Agents</p>
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-3 py-1.5 text-left font-medium">Slug</th>
                        <th className="px-3 py-1.5 text-left font-medium">Name</th>
                        <th className="px-3 py-1.5 text-left font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.plan.agentPlans.map((agent) => (
                        <tr key={agent.slug} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{agent.slug}</td>
                          <td className="px-3 py-1.5">{agent.plannedName}</td>
                          <td className="px-3 py-1.5">
                            <span
                              className={`rounded-full px-2 py-0.5 capitalize ${
                                agent.action === "create"
                                  ? "bg-green-500/10 text-green-700 dark:text-green-400"
                                  : agent.action === "update"
                                  ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {agent.action}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Collision strategy */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">On conflict</p>
              <div className="flex gap-3">
                {(["rename", "skip", "replace"] as CompanyPortabilityCollisionStrategy[]).map((s) => (
                  <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="collision"
                      value={s}
                      checked={collisionStrategy === s}
                      onChange={() => setCollisionStrategy(s)}
                      className="accent-primary"
                    />
                    <span className="text-sm capitalize">{s}</span>
                  </label>
                ))}
              </div>
            </div>

            {importMutation.isError && (
              <p className="text-sm text-destructive">
                {importMutation.error instanceof Error
                  ? importMutation.error.message
                  : "Import failed."}
              </p>
            )}
          </div>
        )}

        {/* Step 3: Import result */}
        {step === "import" && importResult && (
          <div className="space-y-4">
            <div className="rounded-md border border-border px-3 py-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Company</span>
                <span className="text-sm font-medium">{importResult.company.name}</span>
                <span className="text-xs rounded-full border border-border px-2 py-0.5 capitalize">
                  {importResult.company.action}
                </span>
              </div>
            </div>

            {importResult.agents.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  Agents ({importResult.agents.length})
                </p>
                <div className="rounded-md border border-border overflow-hidden max-h-48 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-3 py-1.5 text-left font-medium">Name</th>
                        <th className="px-3 py-1.5 text-left font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.agents.map((agent) => (
                        <tr key={agent.slug} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5">{agent.name}</td>
                          <td className="px-3 py-1.5">
                            <span
                              className={`rounded-full px-2 py-0.5 capitalize ${
                                agent.action === "created"
                                  ? "bg-green-500/10 text-green-700 dark:text-green-400"
                                  : agent.action === "updated"
                                  ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {agent.action}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {importResult.warnings.length > 0 && (
              <div className="space-y-0.5">
                {importResult.warnings.map((warn, i) => (
                  <p key={i} className="text-xs text-amber-600 dark:text-amber-400">{warn}</p>
                ))}
              </div>
            )}

            {importResult.requiredSecrets.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                  Required secrets — configure these in each agent's settings:
                </p>
                <ul className="space-y-0.5">
                  {importResult.requiredSecrets.map((s, i) => (
                    <li key={i} className="text-xs font-mono text-muted-foreground">
                      {s.key}
                      {s.agentSlug && (
                        <span className="ml-1 text-muted-foreground/60">({s.agentSlug})</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "upload" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={() => previewMutation.mutate()}
                disabled={
                  !file ||
                  !parsedManifest ||
                  !!parseError ||
                  previewMutation.isPending
                }
              >
                {previewMutation.isPending ? "Loading preview..." : "Preview"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} disabled={importMutation.isPending}>
                Back
              </Button>
              <Button
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending || (preview?.errors.length ?? 0) > 0}
              >
                {importMutation.isPending ? "Importing..." : "Import"}
              </Button>
            </>
          )}
          {step === "import" && (
            <Button onClick={handleClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
