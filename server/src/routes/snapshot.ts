import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { snapshotExportInputSchema, snapshotImportInputSchema } from "@paperclipai/shared";
import { createSnapshotExporter, createSnapshotImporter } from "../services/snapshot/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export function snapshotRoutes(db: Db) {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SNAPSHOT_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // POST /:companyId/snapshot/export
  router.post("/:companyId/snapshot/export", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const parsed = snapshotExportInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
        return;
      }

      const { passphrase, history, runsPerAgent, pauseAgents } = parsed.data;
      const result = await createSnapshotExporter(db).export({
        companyId,
        passphrase,
        history: history ?? "30d",
        runsPerAgent: runsPerAgent ?? undefined,
        pauseAgents: pauseAgents ?? true,
      });

      res.json({ manifest: result.manifest, warnings: result.warnings, filePath: result.filePath });
    } catch (err) {
      next(err);
    }
  });

  // POST /snapshot/import
  router.post("/snapshot/import", async (req, res, next) => {
    try {
      assertBoard(req);

      try {
        await runSingleFileUpload(req, res);
      } catch (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(422).json({ error: `Snapshot file exceeds ${MAX_SNAPSHOT_BYTES} bytes` });
            return;
          }
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const file = (req as Request & { file?: { buffer: Buffer } }).file;
      if (!file) {
        res.status(400).json({ error: "Missing file field 'file'" });
        return;
      }

      const rawOptions = typeof req.body?.options === "string"
        ? (() => { try { return JSON.parse(req.body.options); } catch { return null; } })()
        : req.body?.options ?? req.body;

      const parsed = snapshotImportInputSchema.safeParse(rawOptions);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid import options", details: parsed.error.issues });
        return;
      }

      const result = await createSnapshotImporter(db).import({
        fileBuffer: file.buffer,
        passphrase: parsed.data.passphrase,
        pathMappings: parsed.data.pathMappings,
        onConflict: parsed.data.onConflict,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /snapshot/inspect
  router.post("/snapshot/inspect", async (req, res, next) => {
    try {
      assertBoard(req);

      try {
        await runSingleFileUpload(req, res);
      } catch (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(422).json({ error: `Snapshot file exceeds ${MAX_SNAPSHOT_BYTES} bytes` });
            return;
          }
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const file = (req as Request & { file?: { buffer: Buffer } }).file;
      if (!file) {
        res.status(400).json({ error: "Missing file field 'file'" });
        return;
      }

      const passphrase = req.body?.passphrase;
      if (typeof passphrase !== "string" || passphrase.length === 0) {
        res.status(400).json({ error: "Missing or invalid 'passphrase' field" });
        return;
      }

      const result = await createSnapshotImporter(db).inspect({
        fileBuffer: file.buffer,
        passphrase,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
