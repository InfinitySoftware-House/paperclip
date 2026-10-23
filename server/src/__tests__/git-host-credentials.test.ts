import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  appendGitConfigEnv,
  buildGitHostAuthConfig,
  gitHostConnectionInfo,
  gitHostForRemoteUrl,
  resolveGitHostCredentials,
  type GitHostCredential,
} from "../services/git-host-credentials.js";
import { createGitRemoteAuthProvider, describeGitAuthFailure } from "../services/git-credentials.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { initializeRunIdentity } from "../services/run-identity.js";

const execFile = promisify(execFileCallback);

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({
    value: `user-token-${input.responsibleUserId}`,
  })),
  resolveSecretValue: vi.fn(async (_company: string, secretId: string) => `company-token-${secretId}`),
  getByName: vi.fn(async () => null),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const credential = (host: string, token: string, baseUrl = `https://${host}`): GitHostCredential => ({
  provider: "gitlab", host, baseUrl, token, source: "managed_connection", secretName: null,
});

/** Ask the real git binary which credential it would send for `host`. */
async function gitCredentialFill(env: Record<string, string>, host: string) {
  const child = execFile("git", ["credential", "fill"], {
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...env },
    timeout: 10_000,
  });
  child.child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
  try {
    const { stdout } = await child;
    return /^password=(.*)$/m.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

describe("git host auth config", () => {
  it("scopes each token to its host and resets only that host's ambient helpers", async () => {
    const auth = buildGitHostAuthConfig([credential("gitlab.example.com", "glpat-one"), credential("git.example.com:3000", "gitea-two")]);
    expect(auth.env).toEqual({ PAPERCLIP_GIT_HOST_TOKEN_0: "glpat-one", PAPERCLIP_GIT_HOST_TOKEN_1: "gitea-two" });
    expect(auth.config.map(([key, value]) => [key, value === "" ? "" : "helper"])).toEqual([
      ["credential.https://gitlab.example.com.helper", ""],
      ["credential.https://gitlab.example.com.helper", "helper"],
      ["url.https://gitlab.example.com/.insteadOf", "helper"],
      ["url.https://gitlab.example.com/.insteadOf", "helper"],
      ["credential.https://git.example.com:3000.helper", ""],
      ["credential.https://git.example.com:3000.helper", "helper"],
    ]);
    expect(JSON.stringify(auth.config)).not.toContain("glpat-one");

    // An operator's ambient helper keeps answering for every other host.
    const ambient = appendGitConfigEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!f() { echo username=ambient; echo password=ambient-token; }; f",
    }, auth);
    expect(ambient.GIT_CONFIG_COUNT).toBe(String(1 + auth.config.length));
    expect(await gitCredentialFill(ambient, "gitlab.example.com")).toBe("glpat-one");
    expect(await gitCredentialFill(ambient, "git.example.com:3000")).toBe("gitea-two");
    expect(await gitCredentialFill(ambient, "github.com")).toBe("ambient-token");
    // Without an ambient helper no other host receives a token.
    expect(await gitCredentialFill(appendGitConfigEnv({}, auth), "evil.example.com")).toBeNull();
  });

  it("recognizes only non-GitHub remotes without inline credentials", () => {
    expect(gitHostForRemoteUrl("https://GitLab.example.com/group/app.git")).toBe("gitlab.example.com");
    expect(gitHostForRemoteUrl("https://git.example.com:3000/team/app")).toBe("git.example.com:3000");
    expect(gitHostForRemoteUrl("git@gitlab.com:group/app.git")).toBe("gitlab.com");
    expect(gitHostForRemoteUrl("ssh://git@codeberg.org/team/app.git")).toBe("codeberg.org");
    expect(gitHostForRemoteUrl("https://github.com/acme/app")).toBeNull();
    expect(gitHostForRemoteUrl("git@github.com:acme/app.git")).toBeNull();
    expect(gitHostForRemoteUrl("https://oauth2:secret@gitlab.com/group/app")).toBeNull();
    expect(gitHostForRemoteUrl("http://gitlab.com/group/app")).toBeNull();
    expect(gitHostForRemoteUrl("/local/path")).toBeNull();
  });

  it("reads the instance host from GitLab and Gitea connections only", () => {
    expect(gitHostConnectionInfo({ config: { sourceTemplateKey: "gitlab", methodConfig: { instanceUrl: "https://Example.com/gitlab/" } } }))
      .toEqual({ provider: "gitlab", host: "example.com", baseUrl: "https://example.com/gitlab" });
    expect(gitHostConnectionInfo({ config: { sourceTemplateKey: "gitea", methodConfig: {} } }))
      .toEqual({ provider: "gitea", host: "gitea.com", baseUrl: "https://gitea.com" });
    expect(gitHostConnectionInfo({ config: { sourceTemplateKey: "gitlab", methodConfig: { instanceUrl: "http://example.com" } } })).toBeNull();
    expect(gitHostConnectionInfo({ config: { sourceTemplateKey: "github" } })).toBeNull();
  });

  it("points unauthenticated GitLab failures at GitLab setup", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled",
      used: null,
      repoUrl: "https://gitlab.example.com/group/app",
    })).toContain("No credential is configured for gitlab.example.com");
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "managed_connection", secretName: null, provider: "gitea" },
    })).toContain("the resolved Gitea connection");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("git host identity resolution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-git-host-credentials-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Builder", role: "engineer", adapterType: "codex_local" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Git host test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values(["A", "B"].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "member",
    })));
    return { companyId, agentId, otherAgentId, runId, issueId };
  }

  async function connection(input: Awaited<ReturnType<typeof seed>>, options: {
    provider?: "gitlab" | "gitea";
    instanceUrl?: string;
    install: { targetType: "company" | "agent"; targetId: string };
    credentialPolicy?: "shared" | "per_user" | "per_agent";
  }) {
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, name: applicationId, type: "mcp_stdio" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: input.companyId, applicationId, name: connectionId, uid: connectionId,
      transport: "rest_api", status: "active", enabled: true, credentialPolicy: options.credentialPolicy ?? "shared",
      config: {
        sourceTemplateKey: options.provider ?? "gitlab", connectionMethodKey: "access-token",
        methodConfig: { instanceUrl: options.instanceUrl ?? "https://gitlab.example.com" },
      },
    });
    await db.insert(toolConnectionInstalls).values({ companyId: input.companyId, connectionId, ...options.install });
    return connectionId;
  }

  async function grant(input: Awaited<ReturnType<typeof seed>>, connectionId: string, kind: "organization" | "user" | "agent", subject?: string) {
    const secretId = randomUUID(), definitionId = randomUUID(), id = randomUUID();
    if (kind === "user") {
      await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: input.companyId, key: definitionId, name: "Token" });
    }
    await db.insert(companySecrets).values({
      id: secretId, companyId: input.companyId, key: secretId, name: `Token ${secretId}`,
      scope: kind === "user" ? "user" : "company",
      ownerUserId: kind === "user" ? subject! : null,
      userSecretDefinitionId: kind === "user" ? definitionId : null,
    });
    await db.insert(connectionGrants).values({
      id, companyId: input.companyId, connectionId, kind, status: "active",
      isDefault: kind === "organization",
      subjectUserId: kind === "user" ? subject! : null,
      subjectAgentId: kind === "agent" ? subject! : null,
      credentialSecretRefs: [{ secretId, configPath: "credentials.token", versionSelector: "latest" }],
    });
    return { id, secretId };
  }

  it("prefers the dedicated agent token, then the responsible user, then the company token", async () => {
    const input = await seed();
    const connectionId = await connection(input, { install: { targetType: "company", targetId: input.companyId } });
    const organization = await grant(input, connectionId, "organization");
    await grant(input, connectionId, "user", "A");
    const dedicated = await grant(input, connectionId, "agent", input.agentId);
    const resolve = (responsibleUserId: string | null, agentId = input.agentId) =>
      resolveGitHostCredentials(db, input.companyId, { agentId, responsibleUserId, allowStandingDelegation: false });

    expect((await resolve("A"))[0]).toMatchObject({
      host: "gitlab.example.com", provider: "gitlab",
      credential: { token: `company-token-${dedicated.secretId}`, identitySource: "dedicated" },
    });
    expect((await resolve("A", input.otherAgentId))[0]?.credential).toMatchObject({ token: "user-token-A", identitySource: "personal" });
    expect((await resolve("B", input.otherAgentId))[0]?.credential).toMatchObject({
      token: `company-token-${organization.secretId}`, identitySource: "organization",
    });

    // A revoked dedicated identity fails visibly instead of falling back to another token.
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, dedicated.id));
    const [revoked] = await resolve("A");
    expect(revoked?.credential).toBeUndefined();
    expect(revoked?.error).toMatch(/must be reconnected/);
  });

  it("respects the install consent boundary and the instance host", async () => {
    const input = await seed();
    const connectionId = await connection(input, { install: { targetType: "agent", targetId: input.otherAgentId }, provider: "gitea", instanceUrl: "https://git.example.com:3000" });
    await grant(input, connectionId, "organization");
    expect(await resolveGitHostCredentials(db, input.companyId, { agentId: input.agentId })).toEqual([]);
    const [selection] = await resolveGitHostCredentials(db, input.companyId, { agentId: input.otherAgentId });
    expect(selection).toMatchObject({ host: "git.example.com:3000", provider: "gitea", credential: { identitySource: "organization" } });
    expect(await resolveGitHostCredentials(db, input.companyId, { agentId: input.otherAgentId }, { onlyHost: "gitlab.example.com" })).toEqual([]);
  });

  it("authenticates server-side clones only for the connected host", async () => {
    const input = await seed();
    const connectionId = await connection(input, { install: { targetType: "company", targetId: input.companyId } });
    const organization = await grant(input, connectionId, "organization");
    const provider = createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId, issueId: input.issueId });
    const auth = await provider("https://gitlab.example.com/group/app.git");
    expect(auth).toMatchObject({ source: "managed_connection", provider: "gitlab" });
    expect(Object.values(auth!.env)).toContain(`company-token-${organization.secretId}`);
    expect(auth!.configArgs.join(" ")).not.toContain(organization.secretId);
    expect(await provider("https://gitlab.other.example/group/app.git")).toBeNull();
  });

  it("brokers per-operation Git host credentials next to GitHub's result", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { companyId: input.companyId, runId: input.runId, responsibleUserId: "A", cause: "instruction" });
    const connectionId = await connection(input, { install: { targetType: "agent", targetId: input.agentId }, credentialPolicy: "per_agent" });
    const dedicated = await grant(input, connectionId, "agent", input.agentId);
    const result = await resolveGitHubOperationCredentials(db, { companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    expect(result.status).toBe("absent");
    expect(result.gitHosts.hosts).toEqual([{ host: "gitlab.example.com", provider: "gitlab", status: "available", source: "dedicated" }]);
    expect(result.gitHosts.env).toEqual({ PAPERCLIP_GIT_HOST_TOKEN_0: `company-token-${dedicated.secretId}` });
    expect(result.gitHosts.config[1]?.[0]).toBe("credential.https://gitlab.example.com.helper");
  });
});
