import { describe, expect, it } from "vitest";
import type { ProjectAttachment, ProjectFileFolder } from "@paperclipai/shared";
import { buildProjectFileTree } from "./ProjectFiles";

const folder = (id: string, name: string, parentId: string | null = null) =>
  ({ id, name, parentId, companyId: "c", projectId: "p" }) as ProjectFileFolder;
const file = (id: string, name: string, folderId: string | null = null) =>
  ({ id, originalFilename: name, folderId }) as ProjectAttachment;

describe("buildProjectFileTree", () => {
  it("nests folders and files, folders first and sorted by name", () => {
    const tree = buildProjectFileTree(
      [folder("b", "beta"), folder("a", "alpha"), folder("s", "specs", "a")],
      [file("1", "z.md"), file("2", "a.png"), file("3", "spec.pdf", "s")],
    );

    expect(tree.map((node) => node.name)).toEqual(["alpha", "beta", "a.png", "z.md"]);
    expect(tree[0]!.path).toBe("d:a");
    expect(tree[0]!.children[0]!.name).toBe("specs");
    expect(tree[0]!.children[0]!.children).toEqual([{ name: "spec.pdf", path: "f:3", kind: "file", children: [] }]);
  });

  it("shows items of an unknown folder at the root instead of hiding them", () => {
    const tree = buildProjectFileTree([folder("x", "orphan", "gone")], [file("1", "lost.md", "gone")]);
    expect(tree.map((node) => node.path)).toEqual(["d:x", "f:1"]);
  });
});
