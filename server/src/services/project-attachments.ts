import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { assets, projectAttachments, projectFileFolders, projects, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

const SIBLING_NAME_CONSTRAINT = "project_file_folders_sibling_name_uq";

function isSiblingNameConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (maybe.code === "23505" && (maybe.constraint ?? maybe.constraint_name) === SIBLING_NAME_CONSTRAINT) return true;
    current = maybe.cause;
  }
  return false;
}

type FolderRef = { id: string; parentId: string | null; name: string };

/** Map each folder id to its slash-joined path from the project root. */
export function projectFolderPaths(folders: FolderRef[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return "";
    seen.add(id);
    const parent = folder.parentId ? resolve(folder.parentId, seen) : "";
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    paths.set(id, path);
    return path;
  };
  for (const folder of folders) resolve(folder.id, new Set());
  return paths;
}

/** The folder ids of `rootId` and everything nested under it. */
function descendantFolderIds(folders: FolderRef[], rootId: string) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const folder of folders) if (folder.parentId === ids[i] && !ids.includes(folder.id)) ids.push(folder.id);
  }
  return ids;
}

const attachmentColumns = {
  id: projectAttachments.id,
  companyId: projectAttachments.companyId,
  projectId: projectAttachments.projectId,
  assetId: projectAttachments.assetId,
  folderId: projectAttachments.folderId,
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

  const listFolders = (projectId: string) =>
    db
      .select()
      .from(projectFileFolders)
      .where(eq(projectFileFolders.projectId, projectId))
      .orderBy(asc(projectFileFolders.name));

  const getFolder = (id: string) =>
    db
      .select()
      .from(projectFileFolders)
      .where(eq(projectFileFolders.id, id))
      .then((rows) => rows[0] ?? null);

  /** A folder can only hold files and folders of its own project. */
  async function assertFolderInProject(folderId: string, projectId: string) {
    const folder = await getFolder(folderId);
    if (!folder || folder.projectId !== projectId) throw unprocessable("Folder does not belong to this project");
    return folder;
  }

  async function withSiblingNameCheck<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (err) {
      if (isSiblingNameConflict(err)) throw conflict("A folder with this name already exists here");
      throw err;
    }
  }

  return {
    listFolders,
    getFolder,

    createFolder: async (input: { projectId: string; parentId?: string | null; name: string }) => {
      const project = await db
        .select({ id: projects.id, companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");
      if (input.parentId) await assertFolderInProject(input.parentId, project.id);
      return withSiblingNameCheck(async () => {
        const [folder] = await db
          .insert(projectFileFolders)
          .values({ companyId: project.companyId, projectId: project.id, parentId: input.parentId ?? null, name: input.name })
          .returning();
        return folder!;
      });
    },

    updateFolder: async (id: string, patch: { name?: string; parentId?: string | null }) => {
      const folder = await getFolder(id);
      if (!folder) throw notFound("Folder not found");
      if (patch.parentId) {
        await assertFolderInProject(patch.parentId, folder.projectId);
        const subtree = descendantFolderIds(await listFolders(folder.projectId), folder.id);
        if (subtree.includes(patch.parentId)) throw unprocessable("A folder cannot be moved inside itself");
      }
      return withSiblingNameCheck(async () => {
        const [updated] = await db
          .update(projectFileFolders)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(projectFileFolders.id, id))
          .returning();
        return updated!;
      });
    },

    /**
     * Delete a folder, its subfolders and every file inside them. Returns the
     * removed files so the caller can delete their stored objects.
     */
    removeFolder: (id: string) =>
      db.transaction(async (tx) => {
        const [folder] = await tx.select().from(projectFileFolders).where(eq(projectFileFolders.id, id));
        if (!folder) return null;
        const folders = await tx
          .select({ id: projectFileFolders.id, parentId: projectFileFolders.parentId, name: projectFileFolders.name })
          .from(projectFileFolders)
          .where(eq(projectFileFolders.projectId, folder.projectId));
        const folderIds = descendantFolderIds(folders, folder.id);
        const files = await tx
          .select(attachmentColumns)
          .from(projectAttachments)
          .innerJoin(assets, eq(projectAttachments.assetId, assets.id))
          .where(and(eq(projectAttachments.projectId, folder.projectId), inArray(projectAttachments.folderId, folderIds)));
        // Deleting the assets cascades to their attachment rows.
        if (files.length > 0) await tx.delete(assets).where(inArray(assets.id, files.map((file) => file.assetId)));
        // Subfolders cascade from their parent.
        await tx.delete(projectFileFolders).where(eq(projectFileFolders.id, folder.id));
        return { folder, files, folderCount: folderIds.length };
      }),

    moveAttachment: async (id: string, folderId: string | null) => {
      const [existing] = await db.select().from(projectAttachments).where(eq(projectAttachments.id, id));
      if (!existing) throw notFound("Attachment not found");
      if (folderId) await assertFolderInProject(folderId, existing.projectId);
      await db
        .update(projectAttachments)
        .set({ folderId, updatedAt: new Date() })
        .where(eq(projectAttachments.id, id));
      return selectAttachments().where(eq(projectAttachments.id, id)).then((rows) => rows[0]!);
    },

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
      folderId?: string | null;
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
      if (input.folderId) await assertFolderInProject(input.folderId, project.id);

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
          .values({ companyId: project.companyId, projectId: project.id, assetId: asset!.id, folderId: input.folderId ?? null })
          .returning();
        return {
          id: attachment!.id,
          companyId: attachment!.companyId,
          projectId: attachment!.projectId,
          assetId: asset!.id,
          folderId: attachment!.folderId,
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
