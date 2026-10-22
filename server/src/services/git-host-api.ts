import { GIT_HOST_CONNECTION_DEFAULT_HOSTS, gitHostCatalogRepositoryId, gitHostInstanceCandidates } from "@paperclipai/shared";
import { HttpError, badRequest, unprocessable } from "../errors.js";
import { classifyRemoteConnectionError, readRemoteConnectionFailure, type RemoteConnectionFailureReason } from "./remote-connection-failure.js";
import type { GitHostConnectionInfo } from "./git-host-credentials.js";
import { gitHostProviderLabel } from "./git-host-credentials.js";

/**
 * Minimal GitLab (REST v4) and Gitea/Forgejo (REST v1) reads used by Apps setup and the
 * project repository picker. Requests go only to the connection's configured instance base;
 * pagination is page-numbered and never follows provider-supplied links. Provider error
 * bodies are never surfaced because they can echo credentials.
 */

export type GitHostRequest = (url: URL, init: RequestInit) => Promise<Response>;

export type GitHostRepository = {
  id: string;
  fullName: string;
  url: string;
  provider: GitHostConnectionInfo["provider"];
  private?: boolean;
  ownerType?: "personal" | "organization";
};

/** Pages loaded per connection: 10 × 100 repositories bounds one picker refresh. */
const MAX_REPOSITORY_PAGES = 10;
const REPOSITORY_PAGE_SIZE = { gitlab: 100, gitea: 50 } as const;
const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

export function gitHostAuthorizationHeader(info: Pick<GitHostConnectionInfo, "provider">, token: string): Record<string, string> {
  return { Authorization: info.provider === "gitea" ? `token ${token}` : `Bearer ${token}` };
}

function apiUrl(info: GitHostConnectionInfo, path: string) {
  return new URL(`${info.baseUrl}${info.provider === "gitlab" ? "/api/v4" : "/api/v1"}${path}`);
}

const UNREACHABLE_REASONS: Record<RemoteConnectionFailureReason, string> = {
  tls_failure: "its HTTPS certificate is not trusted (self-signed, expired or for another name). Use a certificate from a public CA, or add your CA to Paperclip's trusted CAs (PAPERCLIP_TRUSTED_CA_CERTS).",
  dns_failure: "the host name could not be resolved. Check the instance URL.",
  connection_refused: "the connection was refused. Check the host and port.",
  connection_timeout: "the connection timed out. Check that the instance is reachable from the Paperclip server.",
  network_unreachable: "the network is unreachable from the Paperclip server.",
  connection_reset: "the connection was closed by the server. Check that the port serves HTTPS.",
};

/** Why a request never got a response; guard refusals keep their own reviewed message. */
function unreachableReason(error: unknown) {
  if (error instanceof HttpError) {
    return record(error.details)?.code === "remote_http_dns_failed" ? UNREACHABLE_REASONS.dns_failure : error.message;
  }
  const reason = readRemoteConnectionFailure(error) ?? classifyRemoteConnectionError(error);
  if (reason) return UNREACHABLE_REASONS[reason];
  if (error instanceof Error && error.name === "TimeoutError") return UNREACHABLE_REASONS.connection_timeout;
  return "check the instance URL and try again.";
}

async function getJson(info: GitHostConnectionInfo, token: string, path: string, request: GitHostRequest): Promise<unknown> {
  const label = gitHostProviderLabel(info.provider);
  let response: Response;
  try {
    response = await request(apiUrl(info, path), {
      method: "GET",
      headers: { ...gitHostAuthorizationHeader(info, token), accept: "application/json", "user-agent": "Paperclip" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw unprocessable(`Could not reach ${label} at ${info.host}: ${unreachableReason(error)}`, { code: "git_host_unreachable" });
  }
  if (response.status === 401 || response.status === 403) {
    throw unprocessable(`${label} rejected the access token. Create a new token and reconnect.`, { code: "git_host_token_rejected" });
  }
  if (!response.ok) {
    throw unprocessable(`${label} at ${info.host} returned HTTP ${response.status}. Check the instance URL and try again.`, { code: "git_host_request_failed" });
  }
  try {
    return await response.json();
  } catch {
    throw unprocessable(`${label} at ${info.host} did not return JSON. Check that the URL points to ${label}.`, { code: "git_host_invalid_response" });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Confirms the token authenticates a user on this instance. */
export async function validateGitHostToken(info: GitHostConnectionInfo, token: string, request: GitHostRequest) {
  const user = record(await getJson(info, token, "/user", request));
  const login = user?.username ?? user?.login;
  if (typeof login !== "string" || !login) {
    throw unprocessable(`${gitHostProviderLabel(info.provider)} at ${info.host} returned an invalid user. Check the instance URL.`, { code: "git_host_invalid_response" });
  }
  return { login };
}

function errorCode(error: unknown) {
  return error instanceof HttpError ? record(error.details)?.code : undefined;
}

/**
 * Finds the instance API behind whatever was pasted as the instance URL (the instance, a
 * repository link, a clone URL or an SSH remote) and confirms the token on it. Candidates
 * stay on the pasted host; a missing API moves to the next path prefix, while a rejected
 * token or an unreachable host stops at once.
 */
/** Possible API bases for a pasted instance URL, or a 400 that says what to change. */
export function assertGitHostInstanceUrl(provider: GitHostConnectionInfo["provider"], instanceUrl: string) {
  const candidates = gitHostInstanceCandidates(instanceUrl);
  if (candidates.ok) return candidates;
  const label = gitHostProviderLabel(provider);
  throw badRequest(candidates.reason === "insecure"
    ? `${label} URL must start with https://. Plain HTTP would send the access token unencrypted.`
    : `${label} URL is not a valid address. Use the HTTPS address of the instance, for example https://${GIT_HOST_CONNECTION_DEFAULT_HOSTS[provider]}.`,
  { code: candidates.reason === "insecure" ? "git_host_insecure_url" : "git_host_invalid_url" });
}

/**
 * Finds the instance API behind whatever was pasted as the instance URL (the instance, a
 * repository link, a clone URL or an SSH remote) and confirms the token on it. The full
 * pasted path is tried first, so a confirmed base costs one request; then the host root and each
 * path prefix. Candidates stay on the pasted host; a missing API moves to the next one,
 * while a rejected token or an unreachable host stops at once.
 */
export async function discoverGitHostInstance(
  provider: GitHostConnectionInfo["provider"],
  instanceUrl: string,
  token: string,
  request: GitHostRequest,
) {
  const candidates = assertGitHostInstanceUrl(provider, instanceUrl);
  const baseUrls = [...new Set([candidates.baseUrls.at(-1)!, ...candidates.baseUrls])];
  for (const baseUrl of baseUrls) {
    const info = { provider, host: candidates.host, baseUrl };
    try {
      return { info, ...await validateGitHostToken(info, token, request) };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "git_host_request_failed" && code !== "git_host_invalid_response") throw error;
    }
  }
  const label = gitHostProviderLabel(provider);
  throw unprocessable(`No ${label} API was found at ${candidates.host}. Check that the URL points to a ${label} instance.`, { code: "git_host_api_not_found" });
}

function repositoryFrom(info: GitHostConnectionInfo, row: unknown): GitHostRepository | null {
  const value = record(row);
  if (!value || (typeof value.id !== "number" && typeof value.id !== "string") || !/^\d+$/.test(String(value.id))) return null;
  const fullName = info.provider === "gitlab" ? value.path_with_namespace : value.full_name;
  if (typeof fullName !== "string" || !REPOSITORY_PATH.test(fullName) || fullName.split("/").some(part => part === "." || part === "..")) return null;
  // Build the URL from the configured base, never from provider-supplied links.
  const url = `${info.baseUrl}/${fullName}`;
  // GitLab's `simple` listing omits visibility; mark privacy only when it is reported.
  const isPrivate = info.provider === "gitlab"
    ? value.visibility === "private" || value.visibility === "internal"
    : value.private === true;
  const namespaceKind = record(value.namespace)?.kind;
  const ownerType = info.provider === "gitlab"
    ? namespaceKind === "user" ? "personal" as const : namespaceKind === "group" ? "organization" as const : undefined
    : undefined;
  return {
    id: gitHostCatalogRepositoryId(info.provider, info.host, String(value.id)),
    fullName, url, provider: info.provider,
    ...(isPrivate ? { private: true } : {}),
    ...(ownerType ? { ownerType } : {}),
  };
}

/** Repositories the token's user is a member of, newest activity first for GitLab. */
export async function loadGitHostRepositories(info: GitHostConnectionInfo, token: string, request: GitHostRequest) {
  const size = REPOSITORY_PAGE_SIZE[info.provider];
  const repositories: GitHostRepository[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
    const path = info.provider === "gitlab"
      ? `/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=${size}&page=${page}`
      : `/user/repos?limit=${size}&page=${page}`;
    const rows = await getJson(info, token, path, request);
    if (!Array.isArray(rows)) {
      throw unprocessable(`${gitHostProviderLabel(info.provider)} returned invalid repositories`, { code: "git_host_invalid_response" });
    }
    for (const row of rows) {
      const repository = repositoryFrom(info, row);
      if (repository) repositories.push(repository);
    }
    if (rows.length < size) break;
  }
  return repositories;
}
