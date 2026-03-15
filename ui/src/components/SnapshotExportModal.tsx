import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { companiesApi } from "../api/companies";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type HistoryWindow = "30d" | "90d" | "all" | "none";

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companyName?: string;
}

export function SnapshotExportModal({ open, onClose, companyId, companyName }: Props) {
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>("30d");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [pauseAgents, setPauseAgents] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportBundle(companyId, {
        include: { company: true, agents: true },
      }),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${companyName ?? "company"}-snapshot.json`;
      a.click();
      URL.revokeObjectURL(url);
      handleClose();
    },
  });

  function handleClose() {
    setHistoryWindow("30d");
    setPassphrase("");
    setPassphraseConfirm("");
    setPauseAgents(true);
    setValidationError(null);
    exportMutation.reset();
    onClose();
  }

  function handleExport() {
    setValidationError(null);
    if (passphrase.length > 0 && passphrase.length < 12) {
      setValidationError("Passphrase must be at least 12 characters.");
      return;
    }
    if (passphrase !== passphraseConfirm) {
      setValidationError("Passphrases do not match.");
      return;
    }
    exportMutation.mutate();
  }

  const passphraseMismatch = passphraseConfirm.length > 0 && passphrase !== passphraseConfirm;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export Snapshot</DialogTitle>
          <DialogDescription>
            Download a complete snapshot of this organization for backup or migration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* History window */}
          <div className="space-y-1.5">
            <Label htmlFor="history-window">History window</Label>
            <Select
              value={historyWindow}
              onValueChange={(v) => setHistoryWindow(v as HistoryWindow)}
            >
              <SelectTrigger id="history-window" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="all">All history</SelectItem>
                <SelectItem value="none">None (current state only)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Passphrase */}
          <div className="space-y-1.5">
            <Label htmlFor="export-passphrase">
              Passphrase{" "}
              <span className="text-xs font-normal text-muted-foreground">(optional, min 12 chars)</span>
            </Label>
            <input
              id="export-passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Leave empty to skip encryption"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="export-passphrase-confirm">Confirm passphrase</Label>
            <input
              id="export-passphrase-confirm"
              type="password"
              value={passphraseConfirm}
              onChange={(e) => setPassphraseConfirm(e.target.value)}
              placeholder="Re-enter passphrase"
              disabled={passphrase.length === 0}
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
            {passphraseMismatch && (
              <p className="text-xs text-destructive">Passphrases do not match.</p>
            )}
          </div>

          {/* Pause agents toggle */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Pause agents during export</p>
              <p className="text-xs text-muted-foreground">
                Recommended to ensure a consistent snapshot.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pauseAgents}
              onClick={() => setPauseAgents((v) => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                pauseAgents ? "bg-primary" : "bg-input"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  pauseAgents ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Errors */}
          {validationError && (
            <p className="text-sm text-destructive">{validationError}</p>
          )}
          {exportMutation.isError && (
            <p className="text-sm text-destructive">
              {exportMutation.error instanceof Error
                ? exportMutation.error.message
                : "Export failed."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={exportMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={exportMutation.isPending || passphraseMismatch}>
            {exportMutation.isPending ? "Exporting..." : "Export Snapshot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
