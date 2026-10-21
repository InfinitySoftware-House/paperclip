import { desc, eq } from "drizzle-orm";
import { assets, projectAttachments, projects, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";

const attachmentColumns = {
  id: projectAttachments.id,
  companyId: projectAttachments.companyId,
  projectId: projectAttachments.projectId,
  assetId: projectAttachments.assetId,
  provider: assets.provider,
  objectKey: assets.objectKey,
  contentType: assets.contentType,
  byteSize: assets.byteSize,
  sha256: assets.sha256,
  originalFilename: assets.originalFilename,
  createdByAgentId: assets.createdByAgentId,
  createdByUserId: assets.createdByUserId,
  createdAt: projectAttachments.createdAt,
  updatedAt: projectAttachments.updatedAt,
};

export function projectAttachmentService(db: Db) {
  const selectAttachments = () =>
    db
      .select(attachmentColumns)
      .from(projectAttachments)
      .innerJoin(assets, eq(projectAttachments.assetId, assets.id));

  return {
    list: (projectId: string) =>
      selectAttachments()
        .where(eq(projectAttachments.projectId, projectId))
        .orderBy(desc(projectAttachments.createdAt)),

    getById: (id: string) =>
      selectAttachments()
        .where(eq(projectAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (input: {
      projectId: string;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const project = await db
        .select({ id: projects.id, companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: project.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();
        const [attachment] = await tx
          .insert(projectAttachments)
          .values({ companyId: project.companyId, projectId: project.id, assetId: asset!.id })
          .returning();
        return {
          id: attachment!.id,
          companyId: attachment!.companyId,
          projectId: attachment!.projectId,
          assetId: asset!.id,
          provider: asset!.provider,
          objectKey: asset!.objectKey,
          contentType: asset!.contentType,
          byteSize: asset!.byteSize,
          sha256: asset!.sha256,
          originalFilename: asset!.originalFilename,
          createdByAgentId: asset!.createdByAgentId,
          createdByUserId: asset!.createdByUserId,
          createdAt: attachment!.createdAt,
          updatedAt: attachment!.updatedAt,
        };
      });
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const [existing] = await tx
          .select(attachmentColumns)
          .from(projectAttachments)
          .innerJoin(assets, eq(projectAttachments.assetId, assets.id))
          .where(eq(projectAttachments.id, id));
        if (!existing) return null;
        // Deleting the asset cascades to the attachment row.
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    /** Drop assets of a deleted project; the attachment rows already cascaded. */
    removeAssets: async (assetIds: string[]) => {
      for (const assetId of assetIds) await db.delete(assets).where(eq(assets.id, assetId));
    },
  };
}
