import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  toolCatalogEntries,
  toolConnectionInstalls,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { resolveGitHostCredentials } from "../services/git-host-credentials.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitLab and Gitea Apps connections", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-git-host-connections-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  async function seed() {
    const [company] = await db.insert(companies).values({ name: `Git ${randomUUID()}`, issuePrefix: `G${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Builder", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    return { companyId: company!.id, agentId: agent!.id };
  }

  function service(remoteHttpRequest: (url: string, init: RequestInit) => Promise<Response>) {
    return toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest,
    });
  }

  it("connects a dedicated agent GitLab token on a self-managed instance and resolves it for that agent only", async () => {
    const input = await seed();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://gitlab.example.com/gitlab/api/v4/user");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer glpat-agent");
      return Response.json({ id: 1, username: "builder-bot" });
    });
    const connected = await service(request).connectGalleryApp(input.companyId, {
      galleryKey: "gitlab",
      connectionMethodKey: "access-token",
      name: "Builder GitLab",
      grantKind: "agent",
      subjectAgentId: input.agentId,
      credentialValues: { "credentials.token": "glpat-agent" },
      configValues: { instanceUrl: "https://gitlab.example.com/gitlab/" },
    }, { actorType: "user", actorId: "owner" });
    expect(request).toHaveBeenCalled();
    expect(connected.connection).toMatchObject({ credentialPolicy: "per_agent", transport: "rest_api", healthStatus: "ok" });
    expect(connected.catalog).toEqual([]);
    // The wizard finishes with no actions to enable: the connection exists for Git only.
    const finished = await service(request).finishGalleryAppConnection(input.companyId, connected.connectionId, {
      enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [input.agentId] },
    }, { actorType: "user", actorId: "owner" });
    expect(finished.connection).toMatchObject({ status: "active", enabled: true });
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connected.connectionId))).toEqual([]);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    expect(grant).toMatchObject({ kind: "agent", subjectAgentId: input.agentId, status: "active" });
    expect(grant!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.token"]);

    // The Access step installs the connection for the chosen agent.
    await db.insert(toolConnectionInstalls).values({ companyId: input.companyId, connectionId: connected.connectionId, targetType: "agent", targetId: input.agentId });
    const [selection] = await resolveGitHostCredentials(db, input.companyId, { agentId: input.agentId });
    expect(selection).toMatchObject({
      provider: "gitlab", host: "gitlab.example.com", baseUrl: "https://gitlab.example.com/gitlab",
      credential: { token: "glpat-agent", identitySource: "dedicated" },
    });
    expect(await resolveGitHostCredentials(db, input.companyId, { agentId: randomUUID() })).toEqual([]);
  });

  it("rejects a token the instance refuses without storing an active connection", async () => {
    const input = await seed();
    const request = vi.fn(async () => new Response("token glpat-wrong is invalid", { status: 401 }));
    await expect(service(request).connectGalleryApp(input.companyId, {
      galleryKey: "gitea",
      connectionMethodKey: "access-token",
      name: "Company Gitea",
      credentialValues: { "credentials.token": "glpat-wrong" },
      configValues: { instanceUrl: "https://git.example.com:3000" },
    }, { actorType: "user", actorId: "owner" })).rejects.toThrow(/rejected the access token/);
    const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.status, "active")));
    expect(await resolveGitHostCredentials(db, input.companyId, { agentId: input.agentId })).toEqual([]);
    expect(grants.length).toBeLessThanOrEqual(1);
  });

  it("accepts a pasted repository link and stores the instance base it finds", async () => {
    const input = await seed();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("token gitea-token");
      // A sub-path installation: the host root is another site, /git is Gitea.
      if (url === "https://git.example.com:3000/git/api/v1/user") return Response.json({ id: 7, login: "evo" });
      if (url === "https://git.example.com:3000/api/v1/user") return new Response("<html>home</html>", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const connected = await service(request).connectGalleryApp(input.companyId, {
      galleryKey: "gitea",
      connectionMethodKey: "access-token",
      name: "My Gitea",
      credentialValues: { "credentials.token": "gitea-token" },
      configValues: { instanceUrl: "https://git.example.com:3000/git/team/tool.git" },
    }, { actorType: "user", actorId: "owner" });
    // Setup probes the pasted link, the host root and then each prefix; later checks hit the stored base.
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://git.example.com:3000/git/team/tool/api/v1/user",
      "https://git.example.com:3000/api/v1/user",
      "https://git.example.com:3000/git/api/v1/user",
      ...request.mock.calls.slice(3).map(() => "https://git.example.com:3000/git/api/v1/user"),
    ]);
    expect(connected.connection).toMatchObject({ healthStatus: "ok" });
    expect(connected.connection.config).toMatchObject({ methodConfig: { instanceUrl: "https://git.example.com:3000/git" } });
    await service(request).finishGalleryAppConnection(input.companyId, connected.connectionId, {
      enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents",
    }, { actorType: "user", actorId: "owner" });
    // The wizard's Access step then installs the connection for every agent.
    await service(request).putConnectionInstalls(connected.connectionId, { installs: [{ targetType: "company", targetId: input.companyId }] }, { actorType: "user", actorId: "owner" });
    const [selection] = await resolveGitHostCredentials(db, input.companyId, { agentId: input.agentId });
    expect(selection).toMatchObject({ provider: "gitea", host: "git.example.com:3000", baseUrl: "https://git.example.com:3000/git", credential: { token: "gitea-token" } });
  });

  it("explains why plain-HTTP instance URLs are refused", async () => {
    const input = await seed();
    const request = vi.fn();
    await expect(service(request).connectGalleryApp(input.companyId, {
      galleryKey: "gitea",
      connectionMethodKey: "access-token",
      credentialValues: { "credentials.token": "gitea-token" },
      configValues: { instanceUrl: "http://192.168.1.10:3000/team/tool" },
    }, { actorType: "user", actorId: "owner" })).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("must start with https://"),
    });
    expect(request).not.toHaveBeenCalled();
  });
});
