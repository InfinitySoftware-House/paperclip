import { useEffect, useRef, useState } from "react";
import type { GitHostingProvider, ProjectRepository } from "@paperclipai/shared";
import { LockKeyhole, Plus, X } from "lucide-react";
import { GIT_PROVIDER_LABELS, GIT_PROVIDERS, GitProviderIcon } from "./GitProviderIcon";
import { SearchableSelect } from "./SearchableSelect";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

function RepoRow({ repo, onRemove }: { repo: ProjectRepository; onRemove: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <GitProviderIcon provider={repo.provider} className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium" title={repo.fullName}>{repo.fullName}</span>
        {repo.connections.length > 0 && <span className="truncate text-xs text-muted-foreground" title={repo.connections.join(" · ")}>
          {repo.connections.join(" · ")}
        </span>}
      </div>
      {repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" aria-label="Private repository" />}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${repo.fullName}`} onClick={onRemove}><X className="size-4" /></Button>
    </div>
  );
}

function ConnectProviderButtons({ onConnect }: { onConnect: (provider: GitHostingProvider) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {GIT_PROVIDERS.map((provider) => (
        <Button key={provider} type="button" variant={provider === "github" ? "default" : "outline"} onClick={() => onConnect(provider)}>
          <GitProviderIcon provider={provider} className="size-4" />Connect {GIT_PROVIDER_LABELS[provider]}
        </Button>
      ))}
    </div>
  );
}

/** Shared by both review surfaces, ready to extract after design approval. */
export function RepositoryEditor({ selected, onChange, state = "ready", available = [], onRetry, onConnect, disabled = false }: {
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  state?: "ready" | "loading" | "disconnected" | "empty" | "error";
  available?: ProjectRepository[];
  onRetry: () => void;
  disabled?: boolean;
  onConnect: (provider: GitHostingProvider) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [choosingProvider, setChoosingProvider] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showPicker) picker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [showPicker]);
  const options = available.filter((repo) => !selected.some((item) => item.id === repo.id)).map((repo) => ({
    key: repo.id, value: repo.id, label: repo.fullName,
    searchText: [GIT_PROVIDER_LABELS[repo.provider ?? "github"], ...repo.connections].join(" "), repo,
  }));
  const addClassName = selected.length ? "self-start" : "h-24 w-full flex-col gap-2";
  const addLabel = selected.length ? "Add another repo" : "Add repo";
  const connect = (provider: GitHostingProvider) => {
    setChoosingProvider(false);
    onConnect(provider);
  };
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-2"><span className="text-sm font-medium">Source repos</span><span className="text-xs text-muted-foreground">optional</span></div>
      {selected.map((repo) => <RepoRow key={repo.id} repo={repo} onRemove={() => onChange(selected.filter((item) => item.id !== repo.id))} />)}
      {state === "disconnected" ? (
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="outline" className={addClassName}><Plus className="size-4" />{addLabel}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1"><p className="text-sm font-medium">Connect a Git host to pick a repo</p><p className="text-xs text-muted-foreground">Choose from repos you can access through your GitHub, GitLab, or Gitea connections.</p></div>
              <ConnectProviderButtons onConnect={connect} />
            </div>
          </PopoverContent>
        </Popover>
      ) : showPicker ? (
        <div ref={picker} className="flex flex-col gap-2">
          <SearchableSelect<string, (typeof options)[number]>
            value="" groups={[{ id: "available", label: "Available repos", options }]}
            placeholder={addLabel} searchPlaceholder="Search repos…"
            contentClassName="max-h-(--radix-popover-content-available-height) overflow-hidden [&_[data-slot=command]]:max-h-(--radix-popover-content-available-height) [&_[data-slot=command-list]]:min-h-0 [&_[data-slot=command-list]]:flex-1 [&_[data-slot=command-input-wrapper]]:shrink-0"
            loading={state === "loading"} loadingMessage="Loading repos…"
            emptyMessage={state === "error" ? "Couldn’t load repos. Try again." : state === "empty" ? "No repos available. Connect an account with repo access." : "No matching repos. Try another search or connection."}
            renderValue={() => <span className="flex items-center gap-2 text-foreground"><Plus className="size-4" />{addLabel}</span>}
            renderOption={({ repo }) => <><GitProviderIcon provider={repo.provider} className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate">{repo.fullName}</span><span className="truncate text-xs text-muted-foreground">{repo.connections.join(" · ")}</span></span>{repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" />}</>}
            onValueChange={(_, option) => { onChange([...selected, option.repo]); setShowPicker(false); }}
            createItem={state === "error"
              ? { render: () => <>Try again</>, onSelect: () => { onRetry(); } }
              : { render: () => <><Plus className="size-4" />Connect another account</>, onSelect: () => setChoosingProvider(true) }}
          />
          {choosingProvider && <ConnectProviderButtons onConnect={connect} />}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">All GitHub, GitLab, and Gitea connections you can use.</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setShowPicker(false); setChoosingProvider(false); }}>Cancel</Button>
          </div>
        </div>
      ) : <Button type="button" variant="outline" className={addClassName} onClick={() => setShowPicker(true)}><Plus className="size-4" />{addLabel}</Button>}
    </fieldset>
  );
}
