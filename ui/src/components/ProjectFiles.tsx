import { useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectAttachment, ProjectFileFolder } from "@paperclipai/shared";
import {
  Download,
  ExternalLink,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { projectsApi } from "../api/projects";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatBytes } from "../lib/issue-output";
import { cn } from "../lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { FileTree, type FileTreeNode } from "./FileTree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Tree paths carry the kind and id so folders and files never collide.
const folderPath = (id: string) => `d:${id}`;
const filePath = (id: string) => `f:${id}`;
const DRAG_TYPE = "application/x-paperclip-project-file";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function fileName(file: ProjectAttachment) {
  return file.originalFilename?.trim() || "file";
}

type FolderDialog =
  | { mode: "create"; parentId: string | null }
  | { mode: "rename"; folder: ProjectFileFolder };

type DeleteTarget =
  | { kind: "folder"; folder: ProjectFileFolder }
  | { kind: "file"; file: ProjectAttachment };

export function buildProjectFileTree(folders: ProjectFileFolder[], files: ProjectAttachment[]) {
  const folderIds = new Set(folders.map((folder) => folder.id));
  const nodes = new Map<string | null, FileTreeNode[]>();
  const childrenOf = (parentId: string | null) => {
    let list = nodes.get(parentId);
    if (!list) nodes.set(parentId, (list = []));
    return list;
  };
  const byName = (a: FileTreeNode, b: FileTreeNode) => a.name.localeCompare(b.name);
  const folderNodes = new Map<string, FileTreeNode>();
  for (const folder of folders) {
    folderNodes.set(folder.id, { name: folder.name, path: folderPath(folder.id), kind: "dir", children: [] });
  }
  for (const folder of folders) {
    // An unknown parent would hide the folder; show it at the root instead.
    const parentId = folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null;
    childrenOf(parentId).push(folderNodes.get(folder.id)!);
  }
  const fileNodes = new Map<string | null, FileTreeNode[]>();
  for (const file of files) {
    const parentId = file.folderId && folderIds.has(file.folderId) ? file.folderId : null;
    const list = fileNodes.get(parentId) ?? [];
    list.push({ name: fileName(file), path: filePath(file.id), kind: "file", children: [] });
    fileNodes.set(parentId, list);
  }
  // Folders first, then files, each sorted by name.
  const assemble = (parentId: string | null): FileTreeNode[] => {
    const dirs = (nodes.get(parentId) ?? []).sort(byName);
    for (const dir of dirs) dir.children = assemble(dir.path.slice(2));
    return [...dirs, ...(fileNodes.get(parentId) ?? []).sort(byName)];
  };
  return assemble(null);
}

/** Folder ids of `rootId` and everything nested under it. */
function subtreeIds(folders: ProjectFileFolder[], rootId: string) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const folder of folders) if (folder.parentId === ids[i] && !ids.includes(folder.id)) ids.push(folder.id);
  }
  return new Set(ids);
}

function folderPaths(folders: ProjectFileFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const resolve = (folder: ProjectFileFolder, depth = 0): string => {
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    return parent && depth < 64 ? `${resolve(parent, depth + 1)}/${folder.name}` : folder.name;
  };
  return folders
    .map((folder) => ({ id: folder.id, path: resolve(folder) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function ProjectFiles({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const filesKey = queryKeys.projects.attachments(projectId);
  const foldersKey = queryKeys.projects.fileFolders(projectId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [folderName, setFolderName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const filesQuery = useQuery({ queryKey: filesKey, queryFn: () => projectsApi.listAttachments(projectId) });
  const foldersQuery = useQuery({ queryKey: foldersKey, queryFn: () => projectsApi.listFileFolders(projectId) });
  const files = filesQuery.data ?? [];
  const folders = foldersQuery.data ?? [];

  const tree = useMemo(() => buildProjectFileTree(folders, files), [folders, files]);
  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const pathOptions = useMemo(() => folderPaths(folders), [folders]);
  const selectedFile = selectedFileId ? filesById.get(selectedFileId) ?? null : null;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: filesKey }),
    queryClient.invalidateQueries({ queryKey: foldersKey }),
  ]);
  const expand = (folderId: string | null) => {
    if (folderId) setExpanded((previous) => new Set(previous).add(folderPath(folderId)));
  };

  const upload = useMutation({
    mutationFn: async ({ selected, folderId }: { selected: File[]; folderId: string | null }) => {
      for (const file of selected) await projectsApi.uploadAttachment(companyId, projectId, file, folderId);
    },
    onSuccess: (_data, { folderId }) => {
      expand(folderId);
      return refresh();
    },
    onError: (err) => {
      pushToast({ title: "Upload failed", body: errorMessage(err), tone: "error" });
      refresh();
    },
  });

  const saveFolder = useMutation({
    mutationFn: async ({ dialog, name }: { dialog: FolderDialog; name: string }) =>
      dialog.mode === "create"
        ? projectsApi.createFileFolder(companyId, projectId, { name, parentId: dialog.parentId })
        : projectsApi.updateFileFolder(dialog.folder.id, { name }),
    onSuccess: (folder) => {
      expand(folder.parentId);
      setFolderDialog(null);
      return refresh();
    },
    onError: (err) => pushToast({ title: "Could not save folder", body: errorMessage(err), tone: "error" }),
  });

  const move = useMutation({
    mutationFn: async ({ kind, id, folderId }: { kind: "file" | "folder"; id: string; folderId: string | null }) => {
      if (kind === "file") await projectsApi.moveAttachment(id, folderId);
      else await projectsApi.updateFileFolder(id, { parentId: folderId });
    },
    onSuccess: (_data, { folderId }) => {
      expand(folderId);
      return refresh();
    },
    onError: (err) => pushToast({ title: "Move failed", body: errorMessage(err), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (target: DeleteTarget) =>
      target.kind === "file"
        ? projectsApi.deleteAttachment(target.file.id)
        : projectsApi.deleteFileFolder(target.folder.id),
    onSuccess: () => {
      setDeleteTarget(null);
      return refresh();
    },
    onError: (err) => pushToast({ title: "Delete failed", body: errorMessage(err), tone: "error" }),
  });

  function openFolderDialog(dialog: FolderDialog) {
    setFolderName(dialog.mode === "rename" ? dialog.folder.name : "");
    setFolderDialog(dialog);
  }

  function pickFiles(folderId: string | null) {
    uploadTargetRef.current = folderId;
    inputRef.current?.click();
  }

  function submitFolder(event: FormEvent) {
    event.preventDefault();
    const name = folderName.trim();
    if (folderDialog && name) saveFolder.mutate({ dialog: folderDialog, name });
  }

  /** The folder a drop lands in: the hovered folder row, a hovered file's folder, or the root. */
  function dropFolderId(event: DragEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-file-tree-path]");
    const path = row?.dataset.fileTreePath ?? "";
    if (path.startsWith("d:")) return path.slice(2);
    if (path.startsWith("f:")) return filesById.get(path.slice(2))?.folderId ?? null;
    return null;
  }

  function handleDragOver(event: DragEvent) {
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes("Files") && !types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
    setDropTarget(dropFolderId(event) ?? "root");
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDropTarget(null);
    const folderId = dropFolderId(event);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) {
      upload.mutate({ selected: dropped, folderId });
      return;
    }
    const dragged = event.dataTransfer.getData(DRAG_TYPE);
    if (!dragged) return;
    const id = dragged.slice(2);
    if (dragged.startsWith("f:")) {
      const file = filesById.get(id);
      if (file && file.folderId !== folderId) move.mutate({ kind: "file", id, folderId });
    } else if (dragged.startsWith("d:")) {
      const folder = foldersById.get(id);
      if (!folder || folder.parentId === folderId) return;
      if (folderId && subtreeIds(folders, id).has(folderId)) return;
      move.mutate({ kind: "folder", id, folderId });
    }
  }

  function moveMenu(kind: "file" | "folder", id: string, currentFolderId: string | null) {
    const blocked = kind === "folder" ? subtreeIds(folders, id) : new Set<string>();
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <FolderInput className="size-4" />
          Move to
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-(--sz-320px) overflow-auto">
          <DropdownMenuItem
            disabled={currentFolderId === null}
            onSelect={() => move.mutate({ kind, id, folderId: null })}
          >
            Project root
          </DropdownMenuItem>
          {pathOptions.map((option) => (
            <DropdownMenuItem
              key={option.id}
              disabled={option.id === currentFolderId || blocked.has(option.id)}
              onSelect={() => move.mutate({ kind, id, folderId: option.id })}
            >
              <span className="truncate">{option.path}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  function rowMenu(node: FileTreeNode) {
    const id = node.path.slice(2);
    const folder = node.kind === "dir" ? foldersById.get(id) : undefined;
    const file = node.kind === "file" ? filesById.get(id) : undefined;
    if (!folder && !file) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${node.name}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        {/* Portal events still bubble to the tree row, which would toggle or move focus. */}
        <DropdownMenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {folder ? (
            <>
              <DropdownMenuItem onSelect={() => pickFiles(folder.id)}>
                <Upload className="size-4" />
                Upload here
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFolderDialog({ mode: "create", parentId: folder.id })}>
                <FolderPlus className="size-4" />
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFolderDialog({ mode: "rename", folder })}>
                <Pencil className="size-4" />
                Rename
              </DropdownMenuItem>
              {moveMenu("folder", folder.id, folder.parentId)}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget({ kind: "folder", folder })}>
                <Trash2 className="size-4" />
                Delete folder
              </DropdownMenuItem>
            </>
          ) : file ? (
            <>
              <DropdownMenuItem asChild>
                <a href={file.contentPath} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={`${file.contentPath}?download=true`}>
                  <Download className="size-4" />
                  Download
                </a>
              </DropdownMenuItem>
              {moveMenu("file", file.id, file.folderId)}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget({ kind: "file", file })}>
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const error = filesQuery.error ?? foldersQuery.error;
  const deleteFolderStats = deleteTarget?.kind === "folder"
    ? (() => {
        const ids = subtreeIds(folders, deleteTarget.folder.id);
        return { folders: ids.size - 1, files: files.filter((file) => file.folderId && ids.has(file.folderId)).length };
      })()
    : null;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Reference files (PDF, Markdown, images, ...) that agents can read while working on this project.
          Organize them in folders; drag files onto a folder to move or upload them there.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => openFolderDialog({ mode: "create", parentId: null })}>
            <FolderPlus className="size-4" />
            New folder
          </Button>
          <Button size="sm" disabled={upload.isPending} onClick={() => pickFiles(null)}>
            <Upload className="size-4" />
            {upload.isPending ? "Uploading..." : "Upload"}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (selected.length) upload.mutate({ selected, folderId: uploadTargetRef.current });
          }}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-(--gtc-29)">
        <div
          className={cn(
            "min-h-0 overflow-hidden rounded-md border border-border",
            dropTarget === "root" && "ring-2 ring-ring/50",
          )}
          onDragOver={handleDragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={handleDrop}
        >
          <div className="max-h-(--sz-640px) overflow-auto py-1">
            <FileTree
              layout="explorer"
              wrapLabels={false}
              showCheckboxes={false}
              nodes={tree}
              selectedFile={selectedFile ? filePath(selectedFile.id) : null}
              expandedDirs={expanded}
              loading={filesQuery.isLoading || foldersQuery.isLoading}
              error={error ? { message: errorMessage(error), retry: refresh } : null}
              ariaLabel="Project files"
              empty={{
                title: "No files yet",
                description: "Upload reference files or create a folder to get started. You can also drop files here.",
              }}
              onToggleDir={(path) =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })}
              onSelectFile={(path) => setSelectedFileId(path.slice(2))}
              renderLabel={(node) => (
                <span
                  draggable
                  className={cn(
                    "block truncate rounded-sm",
                    dropTarget && node.path === folderPath(dropTarget) && "bg-accent text-foreground",
                  )}
                  title={node.name}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_TYPE, node.path);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                >
                  {node.name}
                </span>
              )}
              renderNodeExtra={(node) => {
                const file = node.kind === "file" ? filesById.get(node.path.slice(2)) : undefined;
                return (
                  <>
                    {file ? (
                      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
                        {formatBytes(file.byteSize)}
                      </span>
                    ) : null}
                    {rowMenu(node)}
                  </>
                );
              }}
            />
          </div>
        </div>

        <FilePreview file={selectedFile} onDelete={(file) => setDeleteTarget({ kind: "file", file })} />
      </div>

      <Dialog open={folderDialog !== null} onOpenChange={(open) => !open && setFolderDialog(null)}>
        <DialogContent>
          <form onSubmit={submitFolder} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
              <DialogDescription>
                {folderDialog?.mode === "create" && folderDialog.parentId
                  ? `Inside ${pathOptions.find((option) => option.id === folderDialog.parentId)?.path ?? "folder"}`
                  : folderDialog?.mode === "create"
                    ? "At the project root"
                    : "Names cannot contain / or \\."}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={folderName}
              maxLength={120}
              placeholder="Folder name"
              aria-label="Folder name"
              onChange={(event) => setFolderName(event.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFolderDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!folderName.trim() || saveFolder.isPending}>
                {folderDialog?.mode === "rename" ? "Rename" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "folder"
                ? `Delete folder "${deleteTarget.folder.name}"?`
                : deleteTarget?.kind === "file"
                  ? `Delete "${fileName(deleteTarget.file)}"?`
                  : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFolderStats
                ? `This also deletes ${deleteFolderStats.files} ${deleteFolderStats.files === 1 ? "file" : "files"} and ${deleteFolderStats.folders} ${deleteFolderStats.folders === 1 ? "subfolder" : "subfolders"} inside it. Agents will no longer see them.`
                : "Agents will no longer see this file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) remove.mutate(deleteTarget);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FilePreview({ file, onDelete }: { file: ProjectAttachment | null; onDelete: (file: ProjectAttachment) => void }) {
  if (!file) {
    return (
      <div className="hidden rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground lg:block">
        Select a file to preview it.
      </div>
    );
  }
  const isImage = file.contentType.startsWith("image/");
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      {isImage ? (
        <a href={file.contentPath} target="_blank" rel="noreferrer" className="block">
          <img
            src={file.contentPath}
            alt={fileName(file)}
            className="max-h-(--sz-320px) w-full rounded-sm bg-muted/30 object-contain"
          />
        </a>
      ) : null}
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={fileName(file)}>{fileName(file)}</div>
        <div className="text-xs text-muted-foreground">
          {formatBytes(file.byteSize)} - {file.contentType}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href={file.contentPath} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            Open
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={`${file.contentPath}?download=true`}>
            <Download className="size-4" />
            Download
          </a>
        </Button>
        <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => onDelete(file)}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}
