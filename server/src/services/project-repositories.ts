import { knownGitHostingProvider, type GitHostingProvider, type ProjectRepository, type ProjectWorkspace } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { isConnectionGrantAudienceAllowed } from "./tool-gateway.js";

export function canBrowseProjectRepositoryGrant(input: {
  grant: { status: string; kind: string; subjectUserId: string | null };
  userId: string | null;
  activeMember: boolean;
  audience: string[];
}) {
  const { grant, userId, activeMember, audience } = input;
  if (grant.status !== "active") return false;
  if (grant.kind === "user") return Boolean(userId && activeMember && grant.subjectUserId === userId);
  return grant.kind === "organization" && isConnectionGrantAudienceAllowed(audience, userId, activeMember);
}

export function mergeProjectRepository(
  repositories: Map<string, ProjectRepository>,
  repo: {
    id: string;
    fullName: string;
    private?: boolean;
    ownerType?: ProjectRepository["ownerType"];
    /** GitLab/Gitea repositories carry their instance URL; GitHub derives it. */
    url?: string;
    provider?: GitHostingProvider;
  },
  connectionName: string,
  connectionId?: string,
) {
  const previous = repositories.get(repo.id);
  const { url, provider, ...rest } = repo;
  repositories.set(repo.id, {
    ...rest, provider: provider ?? "github", url: url ?? `https://github.com/${repo.fullName}`,
    connections: [...new Set([...(previous?.connections ?? []), connectionName])],
    ...(connectionId ? { connectionIds: [...new Set([...(previous?.connectionIds ?? []), connectionId])] } : {}),
  });
}

/** Prefer current provider metadata; unavailable existing selections can remain. */
export function resolveProjectRepositorySelection(
  ids: string[],
  available: ProjectRepository[],
  existing: Pick<ProjectWorkspace, "name" | "repoUrl" | "metadata">[] = [],
): ProjectRepository[] {
  return [...new Set(ids)].map((id) => {
    const current = available.find((repo) => repo.id === id);
    if (current) return current;
    // `githubRepositoryId` predates GitLab/Gitea and holds any catalog repository ID.
    const retained = existing.find((workspace) => workspace.metadata?.githubRepositoryId === id && workspace.repoUrl);
    if (retained) {
      const provider = retained.metadata?.repositoryProvider;
      return {
        id, fullName: retained.name, url: retained.repoUrl!, connections: [],
        ...(provider === "gitlab" || provider === "gitea" || provider === "github" ? { provider } : {}),
      };
    }
    throw unprocessable("A selected repository is no longer available. Refresh repositories and try again.");
  });
}

const REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Register an existing repository URL without assuming it is in the connection catalog.
 * No fetch or credential sharing: execution uses the normal repository access policy,
 * which only authenticates hosts with a configured GitHub, GitLab or Gitea connection.
 *
 * GitHub URLs keep their strict `owner/repo` shape. Other HTTPS hosts (GitLab, Gitea,
 * Forgejo, self-hosted instances on any port or sub-path) accept nested groups, and
 * GitLab's `/-/…` view suffixes are dropped so a pasted browser URL still resolves.
 */
export function normalizeProjectRepositoryUrl(value: string): {
  fullName: string;
  url: string;
  host: string;
  provider: GitHostingProvider | null;
} {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw unprocessable("Repository URL must be an HTTPS Git repository URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw unprocessable("Repository URL must be an HTTPS Git repository URL without credentials, query, or fragment");
  }
  const host = parsed.host.toLowerCase();
  const provider = knownGitHostingProvider(host);
  if (provider === "github") {
    const path = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.port || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)
      || path.split("/").some(part => part === "." || part === "..")) {
      throw unprocessable("Repository URL must identify a GitHub owner and repository");
    }
    return { fullName: path.slice(1), url: `https://github.com${path}`, host: "github.com", provider };
  }
  const path = parsed.pathname.split("/-/")[0]!.replace(/\/+$/, "").replace(/\.git$/, "");
  const segments = path.split("/").slice(1);
  if (segments.length < 2 || segments.some(part => part === "." || part === ".." || !REPOSITORY_PATH_SEGMENT.test(part))) {
    throw unprocessable("Repository URL must identify an owner (or group) and repository");
  }
  return { fullName: segments.join("/"), url: `https://${host}${path}`, host, provider };
}
