import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { StorageService } from "../storage/types.js";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  decide: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  listFolders: vi.fn(),
  getFolder: vi.fn(),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  removeFolder: vi.fn(),
  moveAttachment: vi.fn(),
  logActivity: vi.fn(),
}));

const project = { id: "project-1", companyId: "company-1" };

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ decide: mocks.decide }),
    projectService: () => ({ getById: mocks.getProject }),
    logActivity: mocks.logActivity,
  }));
  vi.doMock("../services/project-attachments.js", () => ({
    projectAttachmentService: () => ({
      list: mocks.list,
      getById: mocks.getById,
      create: mocks.create,
      remove: mocks.remove,
      listFolders: mocks.listFolders,
      getFolder: mocks.getFolder,
      createFolder: mocks.createFolder,
      updateFolder: mocks.updateFolder,
      removeFolder: mocks.removeFolder,
      moveAttachment: mocks.moveAttachment,
    }),
  }));
}

function createStorage(): StorageService {
  return {
    provider: "local_disk" as const,
    putFile: vi.fn(async (input) => ({
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/${input.originalFilename}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(async () => undefined),
  } as unknown as StorageService;
}

async function createApp(storage: StorageService) {
  const { projectAttachmentRoutes } = await vi.importActual<typeof import("../routes/project-attachments.js")>(
    "../routes/project-attachments.js",
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "user-1" } as typeof req.actor;
    next();
  });
  app.use("/api", projectAttachmentRoutes({} as never, storage));
  const { errorHandler } = await vi.importActual<typeof import("../middleware/error-handler.js")>(
    "../middleware/error-handler.js",
  );
  app.use(errorHandler);
  return app;
}

describe("project attachment routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    registerModuleMocks();
    mocks.getProject.mockResolvedValue(project);
    mocks.decide.mockResolvedValue({ allowed: true });
  });

  it("uploads a markdown file under the project namespace", async () => {
    const storage = createStorage();
    mocks.create.mockImplementation(async (input) => ({ id: "att-1", companyId: "company-1", ...input }));
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .attach("file", Buffer.from("# notes"), { filename: "notes.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/project-attachments/att-1/content");
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", namespace: "projects/project-1" }),
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.attachment_added", entityId: "project-1" }),
    );
  });

  it("rejects unsupported content types without storing anything", async () => {
    const storage = createStorage();
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .attach("file", Buffer.from("MZ"), { filename: "run.exe", contentType: "application/x-msdownload" });

    expect(res.status).toBe(422);
    expect(storage.putFile).not.toHaveBeenCalled();
  });

  it("hides a project from another company", async () => {
    mocks.getProject.mockResolvedValue({ id: "project-1", companyId: "company-2" });
    const res = await request(await createApp(createStorage()))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .attach("file", Buffer.from("x"), { filename: "a.md", contentType: "text/markdown" });

    expect(res.status).toBe(404);
  });

  it("returns 404 on read when the actor cannot read the project", async () => {
    mocks.decide.mockResolvedValue({ allowed: false, explanation: "no" });
    const res = await request(await createApp(createStorage())).get("/api/projects/project-1/attachments");

    expect(res.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("deletes the row and its stored object", async () => {
    const storage = createStorage();
    const attachment = { id: "att-1", companyId: "company-1", projectId: "project-1", objectKey: "projects/project-1/a.md", originalFilename: "a.md" };
    mocks.getById.mockResolvedValue(attachment);
    mocks.remove.mockResolvedValue(attachment);
    const res = await request(await createApp(storage)).delete("/api/project-attachments/att-1");

    expect(res.status).toBe(200);
    expect(storage.deleteObject).toHaveBeenCalledWith("company-1", "projects/project-1/a.md");
  });

  it("stores images the browser sent without a MIME type under their real type", async () => {
    const storage = createStorage();
    mocks.create.mockImplementation(async (input) => ({ id: "att-1", companyId: "company-1", ...input }));
    for (const [filename, expected] of [["photo.webp", "image/webp"], ["photo.avif", "image/avif"], ["scan.tiff", "image/tiff"]]) {
      const res = await request(await createApp(storage))
        .post("/api/companies/company-1/projects/project-1/attachments")
        .attach("file", Buffer.from("img"), { filename, contentType: "application/octet-stream" });
      expect(res.status).toBe(201);
      expect(res.body.contentType).toBe(expected);
    }
  });

  it("sanitizes SVG uploads before storing them", async () => {
    const storage = createStorage();
    mocks.create.mockImplementation(async (input) => ({ id: "att-1", companyId: "company-1", ...input }));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onclick="x()" width="4" height="4"/></svg>';
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .attach("file", Buffer.from(svg), { filename: "logo.svg", contentType: "image/svg+xml" });

    expect(res.status).toBe(201);
    const stored = String(vi.mocked(storage.putFile).mock.calls[0]![0].body);
    expect(stored).toContain("<rect");
    expect(stored).not.toContain("script");
    expect(stored).not.toContain("onclick");
  });

  it("rejects an SVG that is not an SVG document", async () => {
    const storage = createStorage();
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .attach("file", Buffer.from("<html><body>hi</body></html>"), { filename: "x.svg", contentType: "image/svg+xml" });

    expect(res.status).toBe(422);
    expect(storage.putFile).not.toHaveBeenCalled();
  });

  it("uploads a file into the requested folder", async () => {
    const storage = createStorage();
    const folderId = "11111111-1111-4111-8111-111111111111";
    mocks.create.mockImplementation(async (input) => ({ id: "att-1", companyId: "company-1", ...input }));
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .field("folderId", folderId)
      .attach("file", Buffer.from("# notes"), { filename: "notes.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ folderId }));
  });

  it("rejects a malformed folder id without storing anything", async () => {
    const storage = createStorage();
    const res = await request(await createApp(storage))
      .post("/api/companies/company-1/projects/project-1/attachments")
      .field("folderId", "../etc")
      .attach("file", Buffer.from("# notes"), { filename: "notes.md", contentType: "text/markdown" });

    expect(res.status).toBe(400);
    expect(storage.putFile).not.toHaveBeenCalled();
  });

  it("creates a folder and logs it", async () => {
    mocks.createFolder.mockResolvedValue({ id: "folder-1", projectId: "project-1", parentId: null, name: "Specs" });
    const res = await request(await createApp(createStorage()))
      .post("/api/companies/company-1/projects/project-1/file-folders")
      .send({ name: "  Specs " });

    expect(res.status).toBe(201);
    expect(mocks.createFolder).toHaveBeenCalledWith({ projectId: "project-1", parentId: null, name: "Specs" });
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.file_folder_created", entityId: "project-1" }),
    );
  });

  it("rejects folder names that look like paths", async () => {
    for (const name of ["a/b", "a\\b", "..", ""]) {
      const res = await request(await createApp(createStorage()))
        .post("/api/companies/company-1/projects/project-1/file-folders")
        .send({ name });
      expect(res.status).toBe(400);
    }
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("refuses folder changes without project write access", async () => {
    mocks.getFolder.mockResolvedValue({ id: "folder-1", companyId: "company-1", projectId: "project-1", parentId: null, name: "A" });
    mocks.decide.mockImplementation(async ({ action }) =>
      action === "project:read" ? { allowed: true } : { allowed: false, explanation: "read only" });
    const res = await request(await createApp(createStorage())).delete("/api/project-file-folders/folder-1");

    expect(res.status).toBe(403);
    expect(mocks.removeFolder).not.toHaveBeenCalled();
  });

  it("deletes a folder with the stored objects of every file inside it", async () => {
    const storage = createStorage();
    const folder = { id: "folder-1", companyId: "company-1", projectId: "project-1", parentId: null, name: "A" };
    mocks.getFolder.mockResolvedValue(folder);
    mocks.removeFolder.mockResolvedValue({
      folder,
      folderCount: 2,
      files: [
        { id: "att-1", companyId: "company-1", objectKey: "projects/project-1/a.md" },
        { id: "att-2", companyId: "company-1", objectKey: "projects/project-1/b.png" },
      ],
    });
    const res = await request(await createApp(storage)).delete("/api/project-file-folders/folder-1");

    expect(res.status).toBe(200);
    expect(res.body.removedFileCount).toBe(2);
    expect(storage.deleteObject).toHaveBeenCalledWith("company-1", "projects/project-1/a.md");
    expect(storage.deleteObject).toHaveBeenCalledWith("company-1", "projects/project-1/b.png");
  });

  it("moves a file to another folder", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    mocks.getById.mockResolvedValue({ id: "att-1", companyId: "company-1", projectId: "project-1", folderId: null });
    mocks.moveAttachment.mockResolvedValue({ id: "att-1", companyId: "company-1", projectId: "project-1", folderId });
    const res = await request(await createApp(createStorage()))
      .patch("/api/project-attachments/att-1")
      .send({ folderId });

    expect(res.status).toBe(200);
    expect(res.body.folderId).toBe(folderId);
    expect(mocks.moveAttachment).toHaveBeenCalledWith("att-1", folderId);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.attachment_moved" }),
    );
  });
});
