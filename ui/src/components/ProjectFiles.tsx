import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Trash2, Upload } from "lucide-react";
import { projectsApi } from "../api/projects";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatBytes } from "../lib/issue-output";
import { Button } from "@/components/ui/button";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

export function ProjectFiles({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const queryKey = queryKeys.projects.attachments(projectId);

  const { data: files = [], isLoading, error } = useQuery({
    queryKey,
    queryFn: () => projectsApi.listAttachments(projectId),
  });

  const upload = useMutation({
    mutationFn: async (selected: File[]) => {
      for (const file of selected) await projectsApi.uploadAttachment(companyId, projectId, file);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (err) => {
      pushToast({ title: "Upload failed", body: errorMessage(err), tone: "error" });
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => projectsApi.deleteAttachment(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (err) => pushToast({ title: "Delete failed", body: errorMessage(err), tone: "error" }),
  });

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Reference files (PDF, Markdown, images, ...) that agents can read while working on this project.
        </p>
        <Button size="sm" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
          <Upload className="size-4" />
          {upload.isPending ? "Uploading..." : "Upload"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (selected.length) upload.mutate(selected);
          }}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {!isLoading && !error && files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files yet.</p>
      ) : null}

      <ul className="divide-y divide-border rounded-md border border-border">
        {files.map((file) => (
          <li key={file.id} className="flex items-center gap-3 p-3">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <a
                href={`/api/project-attachments/${file.id}/content`}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-sm font-medium hover:underline"
              >
                {file.originalFilename ?? "file"}
              </a>
              <span className="text-xs text-muted-foreground">
                {formatBytes(file.byteSize)} - {file.contentType}
              </span>
            </div>
            <Button variant="ghost" size="icon" asChild aria-label="Download">
              <a href={`/api/project-attachments/${file.id}/content?download=true`}>
                <Download className="size-4" />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete"
              disabled={remove.isPending}
              onClick={() => remove.mutate(file.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
