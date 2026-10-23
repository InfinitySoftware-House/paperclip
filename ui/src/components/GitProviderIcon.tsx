import type { GitHostingProvider } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { GithubIcon } from "./icons/github-icon";

export const GIT_PROVIDER_LABELS: Record<GitHostingProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/** Providers a project repository can be connected from, in picker order. */
export const GIT_PROVIDERS: GitHostingProvider[] = ["github", "gitlab", "gitea"];

/** Decorative provider mark for repository rows; GitHub keeps its monochrome icon. */
export function GitProviderIcon({ provider, className }: { provider?: GitHostingProvider; className?: string }) {
  if (!provider || provider === "github") return <GithubIcon className={className} aria-hidden="true" />;
  return <img src={`/brands/apps/${provider}.svg`} alt="" aria-hidden="true" className={cn("object-contain", className)} />;
}
