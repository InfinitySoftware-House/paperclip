import { describe, expect, it, vi } from "vitest";
import { canBrowseProjectRepositoryGrant, mergeProjectRepository, normalizeProjectRepositoryUrl, resolveProjectRepositorySelection } from "../services/project-repositories.js";
import { loadGitHubTokenRepositories } from "../services/tool-access.js";
import type { ProjectRepository } from "@paperclipai/shared";

describe("project repository access", () => {
  const own = { status: "active", kind: "user", subjectUserId: "alice" };
  const shared = { ...own, kind: "organization", subjectUserId: null };
  const allowed = (grant: { status: string; kind: string; subjectUserId: string | null } = own, userId: string | null = "alice", activeMember = true, audience: string[] = []) =>
    canBrowseProjectRepositoryGrant({ grant, userId, activeMember, audience });
  it("includes only the caller's personal identity and active company membership", () => {
    expect(allowed()).toBe(true);
    expect(allowed(own, "bob")).toBe(false);
    expect(allowed(own, null)).toBe(false);
    expect(allowed(own, "alice", false)).toBe(false);
    expect(allowed({ ...own, kind: "agent" })).toBe(false);
    for (const status of ["revoked", "expired", "needs_reauthorization"]) expect(allowed({ ...own, status })).toBe(false);
  });
  it("honors shared audiences without an administrator bypass", () => {
    expect(allowed(shared)).toBe(true);
    expect(allowed(shared, "alice", true, ["alice"])).toBe(true);
    expect(allowed(shared, "alice", true, ["bob"])).toBe(false);
    expect(allowed(shared, "alice", false)).toBe(false);
    expect(allowed(shared, null, false)).toBe(true); // local trusted board
    expect(allowed(shared, null, false, ["alice"])).toBe(false);
  });
  it("deduplicates by provider id across personal and shared connections", () => {
    const repos = new Map<string, ProjectRepository>();
    mergeProjectRepository(repos, { id: "10", fullName: "org/old", ownerType: "organization", private: true }, "Personal");
    mergeProjectRepository(repos, { id: "10", fullName: "org/renamed", ownerType: "organization", private: true }, "Company");
    mergeProjectRepository(repos, { id: "10", fullName: "org/renamed", ownerType: "organization", private: true }, "Company");
    expect([...repos.values()]).toEqual([{ id: "10", fullName: "org/renamed", ownerType: "organization", provider: "github", url: "https://github.com/org/renamed", private: true, connections: ["Personal", "Company"] }]);
  });
  it("keeps GitLab and Gitea repositories with their instance URL and namespaced ID", () => {
    const repos = new Map<string, ProjectRepository>();
    mergeProjectRepository(repos, { id: "gitlab:gitlab.example.com:7", fullName: "group/sub/app", url: "https://gitlab.example.com/group/sub/app", provider: "gitlab" }, "Company GitLab");
    mergeProjectRepository(repos, { id: "10", fullName: "org/app" }, "GitHub");
    expect(repos.get("gitlab:gitlab.example.com:7")).toEqual({ id: "gitlab:gitlab.example.com:7", fullName: "group/sub/app", provider: "gitlab", url: "https://gitlab.example.com/group/sub/app", connections: ["Company GitLab"] });
    expect(repos.get("10")?.url).toBe("https://github.com/org/app");
  });
  it("normalizes GitHub, GitLab and Gitea repository URLs without credentials", () => {
    expect(normalizeProjectRepositoryUrl("https://github.com/acme/web.git/")).toEqual({ fullName: "acme/web", url: "https://github.com/acme/web", host: "github.com", provider: "github" });
    expect(normalizeProjectRepositoryUrl("https://gitlab.com/group/sub/app/-/tree/main")).toEqual({ fullName: "group/sub/app", url: "https://gitlab.com/group/sub/app", host: "gitlab.com", provider: "gitlab" });
    expect(normalizeProjectRepositoryUrl("https://Git.Example.com:3000/team/app.git")).toEqual({ fullName: "team/app", url: "https://git.example.com:3000/team/app", host: "git.example.com:3000", provider: null });
    expect(normalizeProjectRepositoryUrl("https://codeberg.org/forgejo/forgejo").provider).toBe("gitea");
    expect(() => normalizeProjectRepositoryUrl("https://github.com/acme/web/tree/main")).toThrow(/GitHub owner and repository/);
    expect(() => normalizeProjectRepositoryUrl("http://gitlab.com/group/app")).toThrow(/HTTPS/);
    expect(() => normalizeProjectRepositoryUrl("https://oauth2:secret@gitlab.com/group/app")).toThrow(/without credentials/);
    expect(() => normalizeProjectRepositoryUrl("https://gitlab.com/app")).toThrow(/owner \(or group\) and repository/);
    expect(() => normalizeProjectRepositoryUrl("https://gitlab.com/group/../app")).toThrow();
  });
  it("retains unavailable GitLab selections with their provider", () => {
    const existing = [{ name: "group/app", repoUrl: "https://gitlab.com/group/app", metadata: { githubRepositoryId: "gitlab:gitlab.com:5", repositoryProvider: "gitlab" } }];
    expect(resolveProjectRepositorySelection(["gitlab:gitlab.com:5"], [], existing)).toEqual([{ id: "gitlab:gitlab.com:5", fullName: "group/app", url: "https://gitlab.com/group/app", connections: [], provider: "gitlab" }]);
  });
  it("refreshes retained selections from discovery, falls back only for unavailable existing IDs, and rejects new unavailable IDs", () => {
    const existing = [{ name: "old/name", repoUrl: "https://github.com/old/name", metadata: { githubRepositoryId: "1" } }];
    const renamed = { id: "1", fullName: "new/name", url: "https://github.com/new/name", connections: ["Personal"] };
    expect(resolveProjectRepositorySelection(["1", "1"], [renamed], existing)).toEqual([renamed]);
    expect(resolveProjectRepositorySelection(["1"], [], existing)).toEqual([{ id: "1", fullName: "old/name", url: existing[0].repoUrl, connections: [] }]);
    expect(() => resolveProjectRepositorySelection(["2"], [], existing)).toThrow("no longer available");
  });
  it("loads every PAT repository page and never follows provider-supplied URLs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, full_name: "org/a", owner: { type: "Organization" } }]), { headers: { link: '<https://evil.test/steal>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2, full_name: "octocat/b", owner: { type: "User" }, private: true }])));
    expect(await loadGitHubTokenRepositories({ Authorization: "Bearer fixture" }, request)).toEqual([{ id: "1", fullName: "org/a", ownerType: "organization" }, { id: "2", fullName: "octocat/b", ownerType: "personal", private: true }]);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/user/repos?per_page=100&page=1", "https://api.github.com/user/repos?per_page=100&page=2",
    ]);
  });
  it("surfaces failed or invalid provider responses without exposing their body", async () => {
    for (const response of [new Response("secret", { status: 401 }), new Response(JSON.stringify([{ id: 1, full_name: "../bad" }]))]) {
      await expect(loadGitHubTokenRepositories({}, vi.fn().mockResolvedValue(response))).rejects.toThrow(/GitHub/);
    }
  });
});
