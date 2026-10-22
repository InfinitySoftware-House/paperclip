/**
 * Git hosting providers a project repository can live on. GitHub is served by
 * its managed connection; GitLab and Gitea (including self-hosted instances and
 * Gitea-compatible forges such as Forgejo) are served by token connections whose
 * instance URL scopes every credential to exactly one host.
 */
export const GIT_HOSTING_PROVIDERS = ["github", "gitlab", "gitea"] as const;

export type GitHostingProvider = (typeof GIT_HOSTING_PROVIDERS)[number];

/** Apps catalog slugs whose connections authenticate Git for one instance host. */
export const GIT_HOST_CONNECTION_PROVIDERS = ["gitlab", "gitea"] as const;

export type GitHostConnectionProvider = (typeof GIT_HOST_CONNECTION_PROVIDERS)[number];

/** Public instances whose provider is known without a connection. */
const PUBLIC_GIT_HOSTS: Readonly<Record<string, GitHostingProvider>> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "gitea.com": "gitea",
  "codeberg.org": "gitea",
};

export const GIT_HOST_CONNECTION_DEFAULT_HOSTS: Readonly<Record<GitHostConnectionProvider, string>> = {
  gitlab: "gitlab.com",
  gitea: "gitea.com",
};

/**
 * Hostname with an optional port, lowercase. Restricting the alphabet keeps the
 * value safe to embed in Git configuration keys and credential-helper scripts.
 */
export const GIT_HOST_PATTERN = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/**
 * Catalog repository IDs: GitHub keeps its bare numeric ID for compatibility;
 * other providers prefix the provider and host because their numeric IDs are
 * only unique within one instance.
 */
export const PROJECT_REPOSITORY_ID_PATTERN =
  /^(?:\d+|(?:gitlab|gitea):[a-z0-9.-]+(?::\d{1,5})?:\d+)$/;

export function isGitHostConnectionProvider(value: unknown): value is GitHostConnectionProvider {
  return typeof value === "string" && (GIT_HOST_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export function knownGitHostingProvider(host: string): GitHostingProvider | null {
  return PUBLIC_GIT_HOSTS[host.toLowerCase()] ?? null;
}

export function gitHostCatalogRepositoryId(provider: GitHostConnectionProvider, host: string, id: string | number): string {
  return `${provider}:${host.toLowerCase()}:${id}`;
}

export function parseGitHostCatalogRepositoryId(
  id: string,
): { provider: GitHostConnectionProvider; host: string; id: string } | null {
  const match = /^(gitlab|gitea):([a-z0-9.-]+(?::\d{1,5})?):(\d+)$/.exec(id);
  return match ? { provider: match[1] as GitHostConnectionProvider, host: match[2]!, id: match[3]! } : null;
}

/**
 * Normalize a Git host or instance URL to `host[:port]`. Accepts `gitlab.example.com`,
 * `https://gitlab.example.com/` or `https://git.example.com:3000/sub/path`; the path
 * is ignored here and kept by callers that need the API base.
 */
export function normalizeGitHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const host = parsed.host.toLowerCase();
  return GIT_HOST_PATTERN.test(host) ? host : null;
}

/** HTTPS API base for an instance URL, without a trailing slash. */
export function gitHostInstanceBaseUrl(value: string): string | null {
  const host = normalizeGitHost(value);
  if (!host) return null;
  const trimmed = value.trim();
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (parsed.search || parsed.hash) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `https://${host}${path}`;
}

export type GitHostInstanceCandidates =
  | { ok: true; host: string; baseUrls: string[] }
  | { ok: false; reason: "insecure" | "invalid" };

/** Path segments that start a browser page inside a repository, never part of an instance path. */
const REPOSITORY_PAGE_SEGMENTS = new Set(["-", "src", "tree", "blob", "raw", "commits", "commit", "branches", "tags", "releases", "issues", "pulls", "merge_requests", "wiki", "activity", "settings"]);
const MAX_INSTANCE_PATH_SEGMENTS = 4;

/**
 * Possible API bases for whatever a person pasted as the instance URL: the instance
 * itself, a repository link, a `.git` clone URL, or an SSH remote. Returns the host root
 * first and then each longer path prefix, because only the server can tell where a
 * sub-path installation ends and the repository path begins.
 */
export function gitHostInstanceCandidates(value: string): GitHostInstanceCandidates {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: "invalid" };
  // SSH remotes name the host; their HTTPS address uses the default port and root path.
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(trimmed);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\//i.exec(trimmed);
  const sshHost = (scp ?? ssh)?.[1]?.toLowerCase();
  if (sshHost) return GIT_HOST_PATTERN.test(sshHost) ? { ok: true, host: sshHost, baseUrls: [`https://${sshHost}`] } : { ok: false, reason: "invalid" };
  if (/^http:\/\//i.test(trimmed)) return { ok: false, reason: "insecure" };
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false, reason: "invalid" };
  const host = parsed.host.toLowerCase();
  if (!GIT_HOST_PATTERN.test(host)) return { ok: false, reason: "invalid" };
  const segments: string[] = [];
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    if (REPOSITORY_PAGE_SEGMENTS.has(segment) || segments.length >= MAX_INSTANCE_PATH_SEGMENTS) break;
    if (!/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..") return { ok: false, reason: "invalid" };
    segments.push(segment);
  }
  const last = segments.length - 1;
  if (last >= 0 && segments[last]!.endsWith(".git")) segments[last] = segments[last]!.slice(0, -4);
  const baseUrls = [`https://${host}`];
  for (let length = 1; length <= segments.length; length += 1) {
    if (segments[length - 1]) baseUrls.push(`https://${host}/${segments.slice(0, length).join("/")}`);
  }
  return { ok: true, host, baseUrls };
}
