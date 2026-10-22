import { describe, expect, it, vi } from "vitest";
import { loadGitHostRepositories, validateGitHostToken } from "../services/git-host-api.js";

const gitlab = { provider: "gitlab" as const, host: "example.com", baseUrl: "https://example.com/gitlab" };
const gitea = { provider: "gitea" as const, host: "git.example.com:3000", baseUrl: "https://git.example.com:3000" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("git host API", () => {
  it("validates tokens with each provider's auth header against the configured base only", async () => {
    const request = vi.fn(async () => json({ username: "builder" }));
    await expect(validateGitHostToken(gitlab, "glpat-x", request)).resolves.toEqual({ login: "builder" });
    expect(String(request.mock.calls[0]![0])).toBe("https://example.com/gitlab/api/v4/user");
    expect((request.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer glpat-x" });
    expect((request.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");

    const giteaRequest = vi.fn(async () => json({ login: "builder" }));
    await validateGitHostToken(gitea, "tok", giteaRequest);
    expect(String(giteaRequest.mock.calls[0]![0])).toBe("https://git.example.com:3000/api/v1/user");
    expect((giteaRequest.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "token tok" });
  });

  it("reports rejected tokens and unreachable hosts without provider bodies", async () => {
    await expect(validateGitHostToken(gitlab, "bad", vi.fn(async () => new Response("secret-body", { status: 401 }))))
      .rejects.toThrow(/rejected the access token/);
    await expect(validateGitHostToken(gitlab, "bad", vi.fn(async () => { throw new Error("secret detail"); })))
      .rejects.toThrow(/Could not reach GitLab at example.com: check the instance URL/);
    const selfSigned = Object.assign(new Error("secret detail"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    await expect(validateGitHostToken(gitea, "tok", vi.fn(async () => { throw selfSigned; })))
      .rejects.toThrow(/HTTPS certificate is not trusted.*PAPERCLIP_TRUSTED_CA_CERTS/);
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    await expect(validateGitHostToken(gitea, "tok", vi.fn(async () => { throw refused; })))
      .rejects.toThrow(/connection was refused/);
    await expect(validateGitHostToken(gitea, "tok", vi.fn(async () => new Response("<html>", { status: 200 }))))
      .rejects.toThrow(/did not return JSON/);
  });

  it("pages GitLab projects and builds URLs from the configured base, skipping invalid rows", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, path_with_namespace: `group/sub/app-${index}`, visibility: index === 0 ? "private" : undefined,
      namespace: { kind: "group" }, web_url: "https://evil.example/steal",
    }));
    const request = vi.fn()
      .mockResolvedValueOnce(json(page1))
      .mockResolvedValueOnce(json([{ id: 101, path_with_namespace: "me/tool", namespace: { kind: "user" } }, { id: "x", path_with_namespace: "../bad" }]));
    const repositories = await loadGitHostRepositories(gitlab, "glpat-x", request);
    expect(repositories).toHaveLength(101);
    expect(repositories[0]).toEqual({
      id: "gitlab:example.com:1", fullName: "group/sub/app-0", url: "https://example.com/gitlab/group/sub/app-0",
      provider: "gitlab", private: true, ownerType: "organization",
    });
    expect(repositories[100]).toMatchObject({ id: "gitlab:example.com:101", ownerType: "personal" });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.com/gitlab/api/v4/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=100&page=1",
      "https://example.com/gitlab/api/v4/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=100&page=2",
    ]);
  });

  it("lists Gitea repositories with their privacy flag", async () => {
    const request = vi.fn(async () => json([{ id: 7, full_name: "team/app", private: true }]));
    expect(await loadGitHostRepositories(gitea, "tok", request)).toEqual([{
      id: "gitea:git.example.com:3000:7", fullName: "team/app", url: "https://git.example.com:3000/team/app", provider: "gitea", private: true,
    }]);
    expect(String(request.mock.calls[0]![0])).toBe("https://git.example.com:3000/api/v1/user/repos?limit=50&page=1");
  });
});
