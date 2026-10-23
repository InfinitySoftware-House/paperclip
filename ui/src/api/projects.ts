import type {
  Project,
  ProjectAccessMember,
  ProjectAttachment,
  ProjectFileFolder,
  ProjectRepositoryOptions,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const projectsApi = {
  listAttachments: (id: string) => api.get<ProjectAttachment[]>(`/projects/${encodeURIComponent(id)}/attachments`),
  uploadAttachment: (companyId: string, projectId: string, file: File, folderId?: string | null) => {
    const form = new FormData();
    // Multer reads fields in order, so the folder must precede the file.
    if (folderId) form.append("folderId", folderId);
    form.append("file", file);
    return api.postForm<ProjectAttachment>(`/companies/${companyId}/projects/${projectId}/attachments`, form);
  },
  moveAttachment: (attachmentId: string, folderId: string | null) =>
    api.patch<ProjectAttachment>(`/project-attachments/${attachmentId}`, { folderId }),
  deleteAttachment: (attachmentId: string) => api.delete<{ ok: true }>(`/project-attachments/${attachmentId}`),
  listFileFolders: (id: string) => api.get<ProjectFileFolder[]>(`/projects/${encodeURIComponent(id)}/file-folders`),
  createFileFolder: (companyId: string, projectId: string, input: { name: string; parentId?: string | null }) =>
    api.post<ProjectFileFolder>(`/companies/${companyId}/projects/${projectId}/file-folders`, input),
  updateFileFolder: (folderId: string, input: { name?: string; parentId?: string | null }) =>
    api.patch<ProjectFileFolder>(`/project-file-folders/${folderId}`, input),
  deleteFileFolder: (folderId: string) =>
    api.delete<{ ok: true; removedFileCount: number }>(`/project-file-folders/${folderId}`),
  repositoryOptions: (companyId: string) => api.get<ProjectRepositoryOptions>(`/companies/${companyId}/project-repositories`),
  setRepositories: (id: string, repositoryIds: string[]) => api.put<Project>(projectPath(id, undefined, "/repositories"), { repositoryIds }),
  list: (companyId: string, opts: { includeArchived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.includeArchived) params.set("includeArchived", "true");
    const query = params.toString();
    return api.get<Project[]>("/companies/" + encodeURIComponent(companyId) + "/projects" + (query ? "?" + query : ""));
  },
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId)),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listAccessMembers: (id: string, companyId?: string) =>
    api.get<ProjectAccessMember[]>(projectPath(id, companyId, "/access-members")),
  addAccessMember: (
    id: string,
    data: { subjectType: "user" | "agent"; subjectId: string },
    companyId?: string,
  ) => api.post<ProjectAccessMember>(projectPath(id, companyId, "/access-members"), data),
  removeAccessMember: (id: string, memberId: string, companyId?: string) =>
    api.delete<ProjectAccessMember>(
      projectPath(id, companyId, `/access-members/${encodeURIComponent(memberId)}`),
    ),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  controlWorkspaceRuntimeServices: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  controlWorkspaceCommands: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart" | "run",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-commands/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
};
