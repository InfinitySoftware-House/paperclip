import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assets, companies, createDb, projectAttachments, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { projectAttachmentService, projectFolderPaths } from "./project-attachments.js";

describe("project file folders", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("project-file-folders-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Files", issuePrefix: `P${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Docs" }).returning();
    const [other] = await db.insert(projects).values({ companyId, name: "Other" }).returning();
    const svc = projectAttachmentService(db);
    const upload = (projectId: string, name: string, folderId: string | null = null) =>
      svc.create({
        projectId,
        folderId,
        provider: "local_disk",
        objectKey: `${companyId}/${randomUUID()}`,
        contentType: "text/markdown",
        byteSize: 4,
        sha256: "sha",
        originalFilename: name,
      });
    return { companyId, project: project!, other: other!, svc, upload };
  }

  it("nests folders and resolves their paths", async () => {
    const { project, svc } = await fixture();
    const docs = await svc.createFolder({ projectId: project.id, name: "docs" });
    const specs = await svc.createFolder({ projectId: project.id, parentId: docs.id, name: "specs" });

    const paths = projectFolderPaths(await svc.listFolders(project.id));
    expect(paths.get(docs.id)).toBe("docs");
    expect(paths.get(specs.id)).toBe("docs/specs");
  });

  it("refuses duplicate sibling names, also at the root", async () => {
    const { project, svc } = await fixture();
    const docs = await svc.createFolder({ projectId: project.id, name: "docs" });
    await expect(svc.createFolder({ projectId: project.id, name: "docs" })).rejects.toMatchObject({ status: 409 });
    // The same name is fine under another parent.
    await expect(svc.createFolder({ projectId: project.id, parentId: docs.id, name: "docs" })).resolves.toBeTruthy();
  });

  it("refuses to move a folder inside itself or under another project's folder", async () => {
    const { project, other, svc } = await fixture();
    const a = await svc.createFolder({ projectId: project.id, name: "a" });
    const b = await svc.createFolder({ projectId: project.id, parentId: a.id, name: "b" });
    const foreign = await svc.createFolder({ projectId: other.id, name: "foreign" });

    await expect(svc.updateFolder(a.id, { parentId: b.id })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateFolder(a.id, { parentId: a.id })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateFolder(a.id, { parentId: foreign.id })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateFolder(b.id, { parentId: null })).resolves.toMatchObject({ parentId: null });
  });

  it("keeps files inside their own project's folders", async () => {
    const { project, other, svc, upload } = await fixture();
    const foreign = await svc.createFolder({ projectId: other.id, name: "foreign" });
    await expect(upload(project.id, "a.md", foreign.id)).rejects.toMatchObject({ status: 422 });

    const file = await upload(project.id, "a.md");
    await expect(svc.moveAttachment(file.id, foreign.id)).rejects.toMatchObject({ status: 422 });
    const folder = await svc.createFolder({ projectId: project.id, name: "mine" });
    await expect(svc.moveAttachment(file.id, folder.id)).resolves.toMatchObject({ folderId: folder.id });
  });

  it("deletes a folder with its subfolders and files, and leaves the rest", async () => {
    const { project, svc, upload } = await fixture();
    const a = await svc.createFolder({ projectId: project.id, name: "a" });
    const b = await svc.createFolder({ projectId: project.id, parentId: a.id, name: "b" });
    const keep = await svc.createFolder({ projectId: project.id, name: "keep" });
    const inA = await upload(project.id, "in-a.md", a.id);
    const inB = await upload(project.id, "in-b.md", b.id);
    const kept = await upload(project.id, "kept.md", keep.id);
    const root = await upload(project.id, "root.md");

    const removed = await svc.removeFolder(a.id);
    expect(removed?.folderCount).toBe(2);
    expect(removed?.files.map((file) => file.id).sort()).toEqual([inA.id, inB.id].sort());

    expect((await svc.listFolders(project.id)).map((folder) => folder.id)).toEqual([keep.id]);
    expect((await svc.list(project.id)).map((file) => file.id).sort()).toEqual([kept.id, root.id].sort());
    expect(await db.select().from(assets).where(eq(assets.id, inA.assetId))).toHaveLength(0);
    expect(await db.select().from(projectAttachments).where(eq(projectAttachments.id, inB.id))).toHaveLength(0);
  });
});
