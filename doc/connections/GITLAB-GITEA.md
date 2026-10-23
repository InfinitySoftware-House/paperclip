# GitLab and Gitea connections

GitLab and Gitea (including Forgejo and Codeberg) are token connections in the
Apps catalog. They let a project link repositories from those hosts and give
agents Git access over HTTPS for clone, fetch and push. They expose no agent
tool actions; repository work happens through Git.

## Setup

Open **Apps → GitLab** or **Apps → Gitea**, or use **Connect GitLab** / **Connect
Gitea** in a project's **Source repos** picker. Setup asks for:

- **Instance URL** — `https://gitlab.com`, `https://codeberg.org`, or the HTTPS
  address of a self-hosted instance. Ports and sub-paths
  (`https://example.com/gitlab`) are supported. You can also paste a repository
  link, a `.git` clone URL or an SSH remote from the instance: Paperclip finds
  the instance API on that host and stores the instance address. Plain HTTP is
  refused, because the token would cross the network in clear text.
  Instances with a certificate from a private CA need that CA in
  Paperclip's trusted CAs; see `doc/TRUSTED-CERTIFICATES.md`.
- **Access token** — GitLab: a personal, project or group access token with
  `read_api`, `read_repository` and `write_repository`. Gitea: an application
  token with `read:user` and read/write `repository`. Read-only tokens work for
  agents that should not push.

Paperclip validates the token against the instance (`GET /api/v4/user` or
`GET /api/v1/user`) before the connection becomes active.

## Identities and per-agent credentials

The **Access** step offers the same identity choices as GitHub:

| Choice | Grant | Used when |
| --- | --- | --- |
| A dedicated account for an agent | `agent` grant for exactly one agent | That agent always uses this token, regardless of who starts the run |
| My GitLab/Gitea account | personal `user` grant | Runs where you are the responsible person |
| Shared organization account | `organization` grant | Any eligible agent, e.g. a group or bot token |

For every Git operation Paperclip resolves one identity per instance host, in
this order:

1. the agent's dedicated grant;
2. the personal grant of the run's responsible user (who must still be an
   active, non-viewer company member);
3. for automation without a responsible user, a personal grant with a
   standing delegation to the agent (server-side operations only);
4. the connection's company-wide token.

Only connections installed for the company or for the current agent are
considered. A host with such a connection fails visibly — it never falls
through to another person's token. Connect several connections for the same
instance (for example one dedicated connection per agent plus a shared one) to
give agents different identities on the same host.

For gitlab.com and gitea.com only, a `GITLAB_TOKEN` / `GITEA_TOKEN` company
secret (or the same server environment variable) remains a fallback for
server-side checkouts when no connection exists. Self-hosted instances need a
connection, because a bare token carries no host to scope it to.

## How Git receives the token

Tokens never appear in argv, URLs, repository config or files. Each host gets a
URL-scoped Git credential helper (`credential.https://<host>.helper`) that
answers only for `protocol=https` and that exact host, reading the token from a
`PAPERCLIP_GIT_HOST_TOKEN_<n>` environment variable. The host's helper list is
reset first, so an OS keychain cannot shadow the token for that host, while
every other host — including GitHub — keeps its own credentials. SSH remotes on
port-less, root-path instances are rewritten to HTTPS like GitHub's.

- **Managed runs** (sandbox, or a company with a managed GitHub connection):
  the run's `git` launcher asks the control plane for credentials on each
  invocation, so revocations and identity changes apply to the next command.
  The broker returns GitLab/Gitea entries next to the GitHub result.
- **Host-mode runs** (local or SSH execution without a managed GitHub
  connection): the operator's ambient Git and GitHub login stay in place and
  the GitLab/Gitea helpers are appended to the run environment at start.
- **Server-side checkouts** (project workspaces, task repositories) use the
  same resolution for the agent and responsible user of the run.

Low-trust or unverified executions receive no GitLab/Gitea token, exactly like
GitHub credential export.

## Project repositories

The **Source repos** picker lists repositories from every usable GitHub, GitLab
and Gitea connection. GitLab lists projects the token is a member of; Gitea
lists the token user's accessible repositories; each connection loads at most
1,000 repositories per refresh. Repository URLs are built from the configured
instance URL, never from provider-supplied links. GitLab and Gitea catalog IDs
are `provider:host:id` (for example `gitlab:gitlab.example.com:42`); GitHub IDs
stay numeric.

`repositoryUrls` on project creation accepts HTTPS URLs from any host, including
nested GitLab groups and `/-/tree/...` browser URLs. Task repository requests
from agents accept GitHub, gitlab.com, gitea.com and codeberg.org, plus hosts of
connected GitLab/Gitea instances.

## Limits

- Agents get Git access only. Creating merge requests uses Git push options
  (GitLab `-o merge_request.create`, Gitea/Forgejo AGit `refs/for/<branch>`) or
  the provider's API with a token the operator supplies separately; `glab` and
  `tea` do not receive the token.
- The native Runner in a sandbox without any managed GitHub connection stages
  token-free launchers and does not receive GitLab/Gitea credentials.
- Provider webhooks, merge-request reviews and issue sync are GitHub-only.
