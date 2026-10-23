import { describe, expect, it } from "vitest";
import {
  PROJECT_REPOSITORY_ID_PATTERN,
  gitHostCatalogRepositoryId,
  gitHostInstanceBaseUrl,
  gitHostInstanceCandidates,
  knownGitHostingProvider,
  normalizeGitHost,
  parseGitHostCatalogRepositoryId,
} from "./git-hosting.js";

describe("git hosting", () => {
  it("normalizes instance URLs and bare hosts to a safe lowercase host", () => {
    expect(normalizeGitHost("https://GitLab.Example.com/")).toBe("gitlab.example.com");
    expect(normalizeGitHost("git.example.com:3000")).toBe("git.example.com:3000");
    expect(normalizeGitHost("https://git.example.com:3000/sub/path")).toBe("git.example.com:3000");
    expect(normalizeGitHost("http://git.example.com")).toBeNull();
    expect(normalizeGitHost("https://user:token@git.example.com")).toBeNull();
    expect(normalizeGitHost("")).toBeNull();
  });

  it("keeps the instance path as the API base", () => {
    expect(gitHostInstanceBaseUrl("https://example.com/gitlab/")).toBe("https://example.com/gitlab");
    expect(gitHostInstanceBaseUrl("gitea.com")).toBe("https://gitea.com");
    expect(gitHostInstanceBaseUrl("https://example.com/?x=1")).toBeNull();
  });

  it("recognizes public forges without a connection", () => {
    expect(knownGitHostingProvider("github.com")).toBe("github");
    expect(knownGitHostingProvider("GitLab.com")).toBe("gitlab");
    expect(knownGitHostingProvider("codeberg.org")).toBe("gitea");
    expect(knownGitHostingProvider("git.example.com")).toBeNull();
  });

  it("namespaces catalog IDs by provider and host, keeping bare GitHub IDs valid", () => {
    const id = gitHostCatalogRepositoryId("gitlab", "GitLab.Example.com:8443", 42);
    expect(id).toBe("gitlab:gitlab.example.com:8443:42");
    expect(parseGitHostCatalogRepositoryId(id)).toEqual({ provider: "gitlab", host: "gitlab.example.com:8443", id: "42" });
    expect(parseGitHostCatalogRepositoryId("123")).toBeNull();
    for (const valid of ["123", id, "gitea:codeberg.org:7"]) expect(PROJECT_REPOSITORY_ID_PATTERN.test(valid), valid).toBe(true);
    for (const invalid of ["github:github.com:1", "gitlab:host", "gitlab:ho st:1", "abc"]) {
      expect(PROJECT_REPOSITORY_ID_PATTERN.test(invalid), invalid).toBe(false);
    }
  });
});

describe("gitHostInstanceCandidates", () => {
  it("turns repository links, clone URLs and SSH remotes into instance bases, root first", () => {
    expect(gitHostInstanceCandidates("https://git.example.com:3000/team/tool.git")).toEqual({
      ok: true, host: "git.example.com:3000",
      baseUrls: ["https://git.example.com:3000", "https://git.example.com:3000/team", "https://git.example.com:3000/team/tool"],
    });
    expect(gitHostInstanceCandidates("https://gitea.com/gitea/tea/src/branch/main/README.md")).toMatchObject({
      baseUrls: ["https://gitea.com", "https://gitea.com/gitea", "https://gitea.com/gitea/tea"],
    });
    expect(gitHostInstanceCandidates("https://gitlab.example.com/group/api/-/tree/main")).toMatchObject({
      baseUrls: ["https://gitlab.example.com", "https://gitlab.example.com/group", "https://gitlab.example.com/group/api"],
    });
    expect(gitHostInstanceCandidates("codeberg.org")).toEqual({ ok: true, host: "codeberg.org", baseUrls: ["https://codeberg.org"] });
    expect(gitHostInstanceCandidates("git@Git.Example.com:team/tool.git")).toEqual({ ok: true, host: "git.example.com", baseUrls: ["https://git.example.com"] });
    expect(gitHostInstanceCandidates("ssh://git@git.example.com:2222/team/tool.git")).toEqual({ ok: true, host: "git.example.com", baseUrls: ["https://git.example.com"] });
  });

  it("reports plain HTTP separately from malformed input", () => {
    expect(gitHostInstanceCandidates("http://192.168.1.10:3000/team/tool")).toEqual({ ok: false, reason: "insecure" });
    expect(gitHostInstanceCandidates("https://user:secret@git.example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(gitHostInstanceCandidates("ftp://git.example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(gitHostInstanceCandidates("")).toEqual({ ok: false, reason: "invalid" });
  });
});
