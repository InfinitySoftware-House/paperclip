import { and, eq, inArray } from "drizzle-orm";
import {
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  GIT_HOST_CONNECTION_DEFAULT_HOSTS,
  GIT_HOST_PATTERN,
  gitHostInstanceBaseUrl,
  isGitHostConnectionProvider,
  knownGitHostingProvider,
  normalizeGitHost,
  type GitHostConnectionProvider,
} from "@paperclipai/shared";
import { resolveConnectionGrantSecret } from "./connection-credentials.js";
import { secretService } from "./secrets.js";

/**
 * Git credentials for GitLab and Gitea (including Forgejo and self-hosted instances).
 *
 * A GitLab or Gitea Apps connection stores one access token per identity and the HTTPS
 * instance URL that bounds it. Resolution mirrors managed GitHub (see doc/connections/GITHUB.md):
 *
 * 1. the agent's dedicated grant,
 * 2. the personal grant of the run's responsible user,
 * 3. for ownerless automation only, a personal grant with a standing delegation to the agent,
 * 4. then — unlike GitHub — the connection's company-wide token, because GitLab/Gitea
 *    project, group and bot tokens are commonly shared on purpose.
 *
 * Only connections installed for the company or for this agent are considered. A host with
 * such a connection fails visibly instead of falling through to another identity. Tokens are
 * handed to Git through a host-scoped credential helper reading an env var, never argv/URLs.
 */

export const GIT_HOST_TOKEN_CONFIG_PATH = "credentials.token";
export const GIT_HOST_TOKEN_ENV_PREFIX = "PAPERCLIP_GIT_HOST_TOKEN_";

/** Company-secret / server-env names for public instances without a connection. */
export const LEGACY_GIT_HOST_TOKEN_NAMES: Readonly<Record<GitHostConnectionProvider, readonly string[]>> = {
  gitlab: ["GITLAB_TOKEN", "PAPERCLIP_GITLAB_TOKEN"],
  gitea: ["GITEA_TOKEN", "PAPERCLIP_GITEA_TOKEN"],
};

const PROVIDER_LABELS: Readonly<Record<GitHostConnectionProvider, string>> = { gitlab: "GitLab", gitea: "Gitea" };

export function gitHostProviderLabel(provider: GitHostConnectionProvider) {
  return PROVIDER_LABELS[provider];
}

export type GitHostConnectionInfo = {
  provider: GitHostConnectionProvider;
  /** `host[:port]`, lowercase. */
  host: string;
  /** HTTPS instance base without trailing slash, e.g. `https://example.com/gitlab`. */
  baseUrl: string;
};

export type GitHostCredential = GitHostConnectionInfo & {
  token: string;
  source: "managed_connection" | "company_secret" | "server_env";
  secretName: string | null;
  identitySource?: "dedicated" | "personal" | "organization";
  connectionId?: string;
  grantId?: string;
};

export type GitHostCredentialSelection = GitHostConnectionInfo & {
  credential?: GitHostCredential;
  error?: string;
};

type ConnectionRow = typeof toolConnections.$inferSelect;
type GrantRow = typeof connectionGrants.$inferSelect;

export type GitHostCredentialContext = {
  agentId?: string | null;
  responsibleUserId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  allowStandingDelegation?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The provider of a GitLab/Gitea connection, even before its instance URL is confirmed. */
export function gitHostConnectionProvider(connection: { config: unknown }) {
  const provider = asRecord(connection.config).sourceTemplateKey;
  return isGitHostConnectionProvider(provider) ? provider : null;
}

/** The Git host a GitLab/Gitea connection authenticates, or null for any other connection. */
export function gitHostConnectionInfo(connection: { config: unknown }): GitHostConnectionInfo | null {
  const config = asRecord(connection.config);
  const provider = config.sourceTemplateKey;
  if (!isGitHostConnectionProvider(provider)) return null;
  const configured = asRecord(config.methodConfig).instanceUrl;
  const instanceUrl = typeof configured === "string" && configured.trim()
    ? configured
    : `https://${GIT_HOST_CONNECTION_DEFAULT_HOSTS[provider]}`;
  const host = normalizeGitHost(instanceUrl);
  const baseUrl = gitHostInstanceBaseUrl(instanceUrl);
  return host && baseUrl ? { provider, host, baseUrl } : null;
}

function rankCandidates(candidates: GrantRow[]) {
  return [...candidates].sort((a, b) =>
    Number(b.status === "active") - Number(a.status === "active")
    || b.createdAt.getTime() - a.createdAt.getTime()
    || a.id.localeCompare(b.id));
}

/**
 * Resolve one credential per connected GitLab/Gitea host for a run (or for a server-side
 * Git operation when `onlyHost` is given). Secrets are resolved only for hosts that are
 * returned; a company without such connections costs one indexed query.
 */
export async function resolveGitHostCredentials(
  db: Db,
  companyId: string,
  context: GitHostCredentialContext,
  options: { onlyHost?: string } = {},
): Promise<GitHostCredentialSelection[]> {
  const connections = (await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)))
    .flatMap((connection) => {
      // An archived connection is removed, not "configured but unavailable".
      const info = connection.status === "archived" ? null : gitHostConnectionInfo(connection);
      return info && (!options.onlyHost || info.host === options.onlyHost) ? [{ connection, info }] : [];
    });
  if (connections.length === 0) return [];
  const installs = await db.select().from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId),
    inArray(toolConnectionInstalls.connectionId, connections.map(({ connection }) => connection.id)),
  ));
  // The install is the credential owner's consent boundary, exactly as for GitHub.
  const eligible = connections.filter(({ connection }) => installs.some((install) =>
    install.connectionId === connection.id && (
      (install.targetType === "company" && install.targetId === companyId)
      || (Boolean(context.agentId) && install.targetType === "agent" && install.targetId === context.agentId)
    )));
  if (eligible.length === 0) return [];
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId),
    inArray(connectionGrants.connectionId, eligible.map(({ connection }) => connection.id)),
  ));
  const delegatedGrantIds = context.allowStandingDelegation !== false && !context.responsibleUserId && context.agentId
    && grants.some((grant) => grant.kind === "user")
    ? new Set((await db.select({ grantId: connectionGrantDelegations.grantId }).from(connectionGrantDelegations).where(and(
        eq(connectionGrantDelegations.companyId, companyId),
        eq(connectionGrantDelegations.agentId, context.agentId),
        inArray(connectionGrantDelegations.grantId, grants.map((grant) => grant.id)),
      ))).map((row) => row.grantId))
    : new Set<string>();

  const hosts = [...new Set(eligible.map(({ info }) => info.host))].sort();
  const selections: GitHostCredentialSelection[] = [];
  for (const host of hosts) {
    const hostConnections = eligible.filter(({ info }) => info.host === host);
    const info = hostConnections[0]!.info;
    const label = gitHostProviderLabel(info.provider);
    const usable = new Map(hostConnections
      .filter(({ connection }) => connection.enabled && connection.status === "active")
      .map(({ connection }) => [connection.id, connection]));
    if (usable.size === 0) {
      selections.push({ ...info, error: `The ${label} connection for ${host} is unavailable` });
      continue;
    }
    const hostGrants = grants.filter((grant) => usable.has(grant.connectionId));
    const dedicated = context.agentId
      ? hostGrants.filter((grant) => grant.kind === "agent" && grant.subjectAgentId === context.agentId)
      : [];
    const personal = context.responsibleUserId
      ? hostGrants.filter((grant) => grant.kind === "user" && grant.subjectUserId === context.responsibleUserId)
      : [];
    const delegated = hostGrants.filter((grant) => grant.kind === "user" && delegatedGrantIds.has(grant.id));
    const organization = hostGrants.filter((grant) => grant.kind === "organization" && grant.isDefault
      && ["shared", "per_user_with_fallback"].includes(usable.get(grant.connectionId)!.credentialPolicy));
    const tier = dedicated.length ? { grants: dedicated, source: "dedicated" as const }
      : personal.length ? { grants: personal, source: "personal" as const }
      : delegated.length ? { grants: delegated, source: "personal" as const }
      : organization.length ? { grants: organization, source: "organization" as const }
      : null;
    // Connections created before grants existed keep their shared token on the row.
    const legacyShared = !tier
      ? [...usable.values()].find((connection) => connection.credentialPolicy === "shared"
          && !hostGrants.some((grant) => grant.connectionId === connection.id)
          && connection.credentialSecretRefs.some((ref) => ref.configPath === GIT_HOST_TOKEN_CONFIG_PATH))
      : undefined;
    if (!tier && !legacyShared) {
      selections.push({ ...info, error: `No ${label} identity is available for this run on ${host}` });
      continue;
    }
    try {
      const credential = tier
        ? await resolveGrantCredential(db, companyId, usable, rankCandidates(tier.grants)[0]!, tier.source, info, context)
        : await resolveLegacySharedCredential(companyId, legacyShared!, info, context, db);
      selections.push(typeof credential === "string" ? { ...info, error: credential } : { ...info, credential });
    } catch {
      // Secret-store/provider errors can contain sensitive detail. Never surface them.
      selections.push({ ...info, error: `${label} credentials are temporarily unavailable` });
    }
  }
  return selections;
}

async function resolveGrantCredential(
  db: Db,
  companyId: string,
  usable: Map<string, ConnectionRow>,
  grant: GrantRow,
  identitySource: NonNullable<GitHostCredential["identitySource"]>,
  info: GitHostConnectionInfo,
  context: GitHostCredentialContext,
): Promise<GitHostCredential | string> {
  const label = gitHostProviderLabel(info.provider);
  if (grant.status !== "active") return `The ${label} identity for ${info.host} must be reconnected`;
  if (grant.kind === "user" && grant.subjectUserId) {
    const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, grant.subjectUserId),
      eq(companyMemberships.status, "active"),
    )).limit(1);
    if (!membership || membership.role === "viewer") return `The ${label} identity owner is not an authorized company member`;
  }
  const ref = grant.credentialSecretRefs.find((candidate) => candidate.configPath === GIT_HOST_TOKEN_CONFIG_PATH);
  if (!ref) return `The ${label} identity for ${info.host} is incomplete; reconnect it`;
  const connection = usable.get(grant.connectionId)!;
  const { value } = await resolveConnectionGrantSecret(db, connection, grant, ref, {
    consumerType: "tool_connection",
    consumerId: connection.id,
    actorType: "system",
    actorId: context.agentId ?? null,
    issueId: context.issueId ?? null,
    heartbeatRunId: context.heartbeatRunId ?? null,
  });
  const token = value.trim();
  if (!token) return `The ${label} credential for ${info.host} is missing`;
  return {
    ...info, token, source: "managed_connection", secretName: null,
    identitySource, connectionId: connection.id, grantId: grant.id,
  };
}

async function resolveLegacySharedCredential(
  companyId: string,
  connection: ConnectionRow,
  info: GitHostConnectionInfo,
  context: GitHostCredentialContext,
  db: Db,
): Promise<GitHostCredential | string> {
  const ref = connection.credentialSecretRefs.find((candidate) => candidate.configPath === GIT_HOST_TOKEN_CONFIG_PATH)!;
  const token = (await secretService(db).resolveSecretValue(companyId, ref.secretId, ref.versionSelector ?? "latest", {
    accessContext: {
      consumerType: "tool_connection",
      consumerId: connection.id,
      configPath: ref.configPath,
      actorType: "system",
      actorId: context.agentId ?? null,
      issueId: context.issueId ?? null,
      heartbeatRunId: context.heartbeatRunId ?? null,
    },
  })).trim();
  if (!token) return `The ${gitHostProviderLabel(info.provider)} credential for ${info.host} is missing`;
  return { ...info, token, source: "managed_connection", secretName: null, identitySource: "organization", connectionId: connection.id };
}

/**
 * Pre-connection fallback for the public instances only (gitlab.com, gitea.com): a company
 * secret or server env var named after the provider. Self-hosted instances need a connection,
 * because a bare token carries no host to scope it to.
 */
export async function resolveLegacyGitHostCredential(
  db: Db,
  companyId: string,
  host: string,
  context: GitHostCredentialContext,
  deps: {
    secrets?: {
      getByName: (companyId: string, name: string) => Promise<{ id: string } | null | undefined>;
      resolveSecretValue: ReturnType<typeof secretService>["resolveSecretValue"];
    };
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<GitHostCredential | null> {
  const provider = (Object.keys(GIT_HOST_CONNECTION_DEFAULT_HOSTS) as GitHostConnectionProvider[])
    .find((candidate) => GIT_HOST_CONNECTION_DEFAULT_HOSTS[candidate] === host);
  if (!provider) return null;
  const info = { provider, host, baseUrl: `https://${host}` };
  const secrets = deps.secrets ?? secretService(db);
  for (const secretName of LEGACY_GIT_HOST_TOKEN_NAMES[provider]) {
    const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "workspace-git-credential",
        actorType: "system",
        issueId: context.issueId ?? null,
        heartbeatRunId: context.heartbeatRunId ?? null,
        responsibleUserId: context.responsibleUserId ?? null,
      },
    }).then((value) => value.trim()).catch(() => "");
    if (token) return { ...info, token, source: "company_secret", secretName };
  }
  const env = deps.env ?? process.env;
  const envToken = LEGACY_GIT_HOST_TOKEN_NAMES[provider].map((name) => env[name]?.trim()).find(Boolean);
  return envToken ? { ...info, token: envToken, source: "server_env", secretName: null } : null;
}

/**
 * The host of an `https://`, `ssh://git@` or `git@host:` remote that is not GitHub and carries
 * no inline credential — a candidate for a GitLab/Gitea connection. Null otherwise.
 */
export function gitHostForRemoteUrl(remoteUrl: string): string | null {
  const scp = /^git@([a-z0-9.-]+):[^\s]+$/i.exec(remoteUrl);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    return GIT_HOST_PATTERN.test(host) && knownGitHostingProvider(host) !== "github" ? host : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol === "ssh:") {
    if (parsed.username !== "git" || parsed.password || parsed.port) return null;
  } else if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }
  const host = parsed.host.toLowerCase();
  if (!GIT_HOST_PATTERN.test(host) || knownGitHostingProvider(host) === "github") return null;
  return host;
}

// Same shape as the GitHub helper: answer only `get`, and only when git's own request
// describes this exact host over https. `HOST` passes GIT_HOST_PATTERN, so it contains
// no shell or glob metacharacters; the token stays in the named env var.
function gitHostCredentialHelper(host: string, envKey: string) {
  if (!GIT_HOST_PATTERN.test(host) || !/^PAPERCLIP_GIT_HOST_TOKEN_\d+$/.test(envKey)) {
    throw new Error("Invalid Git host credential helper input");
  }
  return `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=${host}) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=oauth2\\npassword=%s\\n' "$${envKey}"; fi; }; f`;
}

export type GitHostAuthConfig = {
  /** Git config entries to append after any existing `GIT_CONFIG_*` entries. */
  config: Array<[string, string]>;
  /** Token env vars referenced by the helpers. */
  env: Record<string, string>;
};

/**
 * Host-scoped Git configuration for the resolved credentials. Each host first resets its
 * own helper list (an empty `credential.<url>.helper` clears helpers configured before it,
 * such as an OS keychain) and then installs one helper, so ambient helpers for other hosts —
 * including a host-mode GitHub login — stay untouched.
 */
export function buildGitHostAuthConfig(credentials: GitHostCredential[]): GitHostAuthConfig {
  const config: Array<[string, string]> = [];
  const env: Record<string, string> = {};
  credentials.forEach((credential, index) => {
    const envKey = `${GIT_HOST_TOKEN_ENV_PREFIX}${index}`;
    env[envKey] = credential.token;
    const scope = `credential.https://${credential.host}.helper`;
    config.push([scope, ""], [scope, gitHostCredentialHelper(credential.host, envKey)]);
    // SSH remotes for the same repository authenticate over HTTPS instead, like GitHub's.
    if (!credential.host.includes(":") && new URL(credential.baseUrl).pathname === "/") {
      config.push(
        [`url.https://${credential.host}/.insteadOf`, `git@${credential.host}:`],
        [`url.https://${credential.host}/.insteadOf`, `ssh://git@${credential.host}/`],
      );
    }
  });
  return { config, env };
}

/** Append config entries to an env that may already carry `GIT_CONFIG_COUNT` entries. */
export function appendGitConfigEnv(env: Record<string, string>, auth: GitHostAuthConfig): Record<string, string> {
  if (auth.config.length === 0) return env;
  const next = { ...env, ...auth.env };
  let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isInteger(count) || count < 0) count = 0;
  for (const [key, value] of auth.config) {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  next.GIT_CONFIG_COUNT = String(count);
  return next;
}
