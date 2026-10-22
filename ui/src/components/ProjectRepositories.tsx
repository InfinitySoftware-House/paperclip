import { LegacyProjectRepository } from "./LegacyProjectRepository";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GitHostingProvider, Project, ProjectRepository } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { ProjectRepositoryInput, repositoryOptionsKey } from "./ProjectRepositoryInput";
import { GIT_PROVIDER_LABELS } from "./GitProviderIcon";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";

export function ProjectRepositories({ project }: { project: Project }) {
  const client = useQueryClient();
  const saved: ProjectRepository[] = project.workspaces.flatMap((workspace) => {
    const id = workspace.metadata?.githubRepositoryId;
    const provider = workspace.metadata?.repositoryProvider;
    return typeof id === "string" && workspace.repoUrl ? [{
      id, fullName: workspace.name, url: workspace.repoUrl, connections: [],
      ...(provider === "github" || provider === "gitlab" || provider === "gitea" ? { provider } : {}),
    }] : [];
  });
  const [draft, setDraft] = useState<ProjectRepository[] | null>(null);
  const [connecting, setConnecting] = useState<GitHostingProvider | null>(null);
  const save = useMutation({
    mutationFn: () => projectsApi.setRepositories(project.id, (draft ?? saved).map((repo) => repo.id)),
    onSuccess: (updated) => {
      for (const ref of new Set([project.id, project.urlKey])) {
        client.setQueriesData({ queryKey: queryKeys.projects.detail(ref) }, updated);
        void client.invalidateQueries({ queryKey: queryKeys.projects.detail(ref) });
      }
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      setDraft(null);
    },
  });
  return <section aria-label="Repositories" className="flex min-w-0 flex-col gap-4 py-4">
    <ProjectRepositoryInput companyId={project.companyId} selected={draft ?? saved} onChange={(repos) => { setDraft(repos); save.reset(); }} onConnect={setConnecting} disabled={save.isPending} />
    {project.workspaces.filter((workspace) => workspace.repoUrl && !workspace.metadata?.githubRepositoryId).map((workspace) => <LegacyProjectRepository key={workspace.id} workspace={workspace} projectRef={project.urlKey} />)}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {save.isError && <p role="alert" className="mr-auto text-sm text-destructive">{save.error.message}</p>}
      {save.isSuccess && <span role="status" className="mr-auto text-sm text-muted-foreground">Changes saved</span>}
      {draft && <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { setDraft(null); save.reset(); }}>Discard changes</Button>}
      <Button type="button" disabled={!draft || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save changes"}</Button>
    </div>
    <Dialog open={connecting !== null} onOpenChange={(open) => { if (!open) setConnecting(null); }}><DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-(--sz-calc-18) overflow-y-auto sm:max-w-2xl">
      <DialogTitle className="sr-only">Connect {GIT_PROVIDER_LABELS[connecting ?? "github"]}</DialogTitle>
      {connecting && <ConnectionSetupFlow key={connecting} host="dialog" serviceSlug={connecting} forceNewConnection onCancel={() => setConnecting(null)} onComplete={() => {
        void client.invalidateQueries({ queryKey: repositoryOptionsKey(project.companyId) });
        setConnecting(null);
      }} />}
    </DialogContent></Dialog>
  </section>;
}
