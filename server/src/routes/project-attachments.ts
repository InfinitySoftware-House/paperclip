import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { accessService, logActivity, projectService } from "../services/index.js";
import { projectAttachmentService } from "../services/project-attachments.js";
import {
  formatAttachmentSize,
  isAllowedContentType,
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeUploadAttachmentContentType,
} from "../attachment-types.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const SVG_CONTENT_TYPE = "image/svg+xml";

function withContentPath<T extends { id: string }>(attachment: T) {
  return { ...attachment, contentPath: `/api/project-attachments/${attachment.id}/content` };
}

export function projectAttachmentRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const projects = projectService(db);
  const svc = projectAttachmentService(db);
  const access = accessService(db);

  async function assertProjectReadAllowed(req: Request, res: Response, project: { id: string; companyId: string }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (decision.allowed) return true;
    res.status(404).json({ error: "Project not found" });
    return false;
  }

  // Same gate as project workspace writes: board operators, or agents with an
  // explicit grant. Reading a project's files stays open to anyone who can read it.
  async function assertProjectWriteAllowed(req: Request, res: Response, project: { id: string; companyId: string }) {
    const assigneeAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;
    const decision = await access.decide({
      actor: req.actor,
      action: "project:write_workspace",
      resource: { type: "issue", companyId: project.companyId, projectId: project.id, assigneeAgentId },
      scope: { projectId: project.id, assigneeAgentId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: decision.explanation });
    return false;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    const upload = multer({
      storage: multer.memoryStorage(),
      defParamCharset: "utf8",
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
  }

  router.get("/projects/:id/attachments", async (req, res) => {
    const project = await getAccessibleResource(req, res, projects.getById(req.params.id as string), "Project not found");
    if (!project) return;
    if (!(await assertProjectReadAllowed(req, res, project))) return;
    res.json((await svc.list(project.id)).map(withContentPath));
  });

  router.post("/companies/:companyId/projects/:projectId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const project = await projects.getById(req.params.projectId as string);
    if (!project || project.companyId !== companyId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!(await assertProjectReadAllowed(req, res, project))) return;
    if (!(await assertProjectWriteAllowed(req, res, project))) return;

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "File is empty" });
      return;
    }
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: file.originalname,
      isAllowedContentType,
    });
    // SVG is not in the default allowlist and is never sanitized here.
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType}` });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `projects/${project.id}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    let attachment: Awaited<ReturnType<typeof svc.create>>;
    try {
      attachment = await svc.create({
        projectId: project.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (err) {
      // Only a project that vanished mid-upload is a definite rejection; any
      // other failure is ambiguous, so keep the object rather than risk a live row.
      if ((err as { status?: number }).status === 404) {
        await storage.deleteObject(companyId, stored.objectKey).catch((cleanupErr) =>
          logger.warn({ cleanupErr, companyId, projectId: project.id }, "failed to remove orphaned project file"));
      }
      throw err;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "project.attachment_added",
      entityType: "project",
      entityId: project.id,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });
    res.status(201).json(withContentPath(attachment));
  });

  router.get("/project-attachments/:attachmentId/content", async (req, res, next) => {
    const attachment = await getAccessibleResource(
      req, res, svc.getById(req.params.attachmentId as string), "Attachment not found");
    if (!attachment) return;
    if (!(await assertProjectReadAllowed(req, res, { id: attachment.projectId, companyId: attachment.companyId }))) return;

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const mediaType = attachment.contentType.split(";", 1)[0]!.trim().toLowerCase();
    const inline = mediaType !== SVG_CONTENT_TYPE && isInlineAttachmentContentType(mediaType)
      && req.query.download !== "true";
    res.attachment(attachment.originalFilename ?? "attachment");
    res.setHeader("Content-Type", mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!inline) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      String(res.getHeader("Content-Disposition")).replace(/^attachment;/, `${inline ? "inline" : "attachment"};`),
    );
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    object.stream.on("error", next);
    res.on("close", () => object.stream.destroy());
    object.stream.pipe(res);
  });

  router.delete("/project-attachments/:attachmentId", async (req, res) => {
    const attachment = await getAccessibleResource(
      req, res, svc.getById(req.params.attachmentId as string), "Attachment not found");
    if (!attachment) return;
    const target = { id: attachment.projectId, companyId: attachment.companyId };
    if (!(await assertProjectReadAllowed(req, res, target))) return;
    if (!(await assertProjectWriteAllowed(req, res, target))) return;

    const removed = await svc.remove(attachment.id);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    await storage.deleteObject(removed.companyId, removed.objectKey).catch((err) =>
      logger.warn({ err, attachmentId: removed.id }, "storage delete failed while removing project file"));

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "project.attachment_removed",
      entityType: "project",
      entityId: removed.projectId,
      details: { attachmentId: removed.id, originalFilename: removed.originalFilename },
    });
    res.json({ ok: true });
  });

  return router;
}
