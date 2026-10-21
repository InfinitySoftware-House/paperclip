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
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "user-1" } as typeof req.actor;
    next();
  });
  app.use("/api", projectAttachmentRoutes({} as never, storage));
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
});
