import { describe, expect, it } from "vitest";
import { buildPaperclipTaskMarkdown } from "./task-markdown.js";

const issue = {
  id: "task-1",
  identifier: "TEST-1",
  title: "Inspect the evidence",
};

describe("heartbeat task markdown rendering", () => {
  it("returns null without a task or a nonempty wake comment", () => {
    expect(buildPaperclipTaskMarkdown({ issue: null })).toBeNull();
    expect(buildPaperclipTaskMarkdown({
      issue: null,
      wakeComments: [{ id: "empty", body: " \n " }],
    })).toBeNull();
  });

  it("renders comment-only context in order without changing the input", () => {
    const input = {
      issue: null,
      wakeComments: [
        Object.freeze({ id: "first", body: "  First request.  " }),
        Object.freeze({ id: "empty", body: "  " }),
        Object.freeze({ id: "last", body: "\nLatest request.\n" }),
      ],
    };
    const before = structuredClone(input);
    const markdown = buildPaperclipTaskMarkdown(input)!;

    expect(markdown).toContain("Pending wake comments (oldest to newest):");
    expect(markdown.indexOf('("first")')).toBeLessThan(markdown.indexOf('("last")'));
    expect(markdown).toContain("\nFirst request.\n");
    expect(markdown).toContain("\nLatest request.\n");
    expect(markdown).not.toContain('("empty")');
    expect(input).toEqual(before);
    expect(buildPaperclipTaskMarkdown(input)).toBe(markdown);
  });

  it("quotes task scalars and keeps embedded code fences inside the description", () => {
    const description = "First line.\n````text\nQuoted instruction.\n````\nLast line.";
    const title = 'A "quoted" title\nwith a second line';
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, title, description },
    });

    expect(markdown).toContain(`- Title: ${JSON.stringify(title)}`);
    expect(markdown).toContain(`Issue description:\n\`\`\`\`\`text\n${description}\n\`\`\`\`\``);
  });

  it("keeps the nearest six ancestors and reports omitted ancestor context", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      ancestors: Array.from({ length: 7 }, (_, index) => ({
        id: `ancestor-${index + 1}`,
        title: `Ancestor title ${index + 1}`,
      })),
    });

    expect(markdown).toContain("- Parent: ancestor-1 Ancestor title 1");
    expect(markdown).toContain("- Ancestor 6: ancestor-6 Ancestor title 6");
    expect(markdown).not.toContain("ancestor-7");
    expect(markdown).toContain("[ancestor context truncated after 6 entries]");
  });

  it.each([true, false])("retains attachment-only wakes with hidden comment bodies (native=%s)", (nativeRunner) => {
    const contentPath = "/api/attachments/attachment-1/content";
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      nativeRunner,
      includeWakeComments: false,
      wakeComments: [{
        id: "comment-file",
        body: "  ",
        attachments: [{
          id: "attachment-1",
          filename: "evidence.txt",
          contentType: "text/plain",
          byteSize: 42,
          contentPath,
        }],
      }],
    });

    expect(markdown).toContain('Attachments on wake comment "comment-file":');
    expect(markdown).toContain('"filename":"evidence.txt"');
    expect(markdown).toContain("Attachment directive:");
    if (nativeRunner) {
      expect(markdown).not.toContain(contentPath);
      expect(markdown).toContain("read_task_attachment");
    } else {
      expect(markdown).toContain(contentPath);
      expect(markdown).toContain("PAPERCLIP_API_KEY");
    }
  });

  it("keeps a rejected plan from granting execution through an older acceptance", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, workMode: "planning" },
      acceptedPlanContinuation: true,
      interaction: { kind: "request_confirmation", status: "accepted" },
      acceptedPlan: { revisionId: "old-approved-revision", revisionNumber: 1 },
      planReview: { status: "rejected", reason: "Revise the scope.\n```\nQuoted feedback.\n```" },
    });

    expect(markdown).toContain("Rejected plan review directive:");
    expect(markdown).toContain("Make the plan only. Do not write code or perform implementation work.");
    expect(markdown).toContain("This is not approval to implement or hand off execution tasks.");
    expect(markdown).toContain("````text\nRevise the scope.");
    expect(markdown).not.toContain("Implement the accepted plan");
    expect(markdown).not.toContain("old-approved-revision");
  });

  describe("project reference files", () => {
    const file = (n: number) => ({
      id: `file-${n}`,
      filename: `notes-${n}.md`,
      contentType: "text/markdown",
      byteSize: 100 + n,
      contentPath: `/api/project-attachments/file-${n}/content`,
    });

    it("lists them with an API download directive for key-holding agents", () => {
      const markdown = buildPaperclipTaskMarkdown({ issue, projectFiles: [file(1)] })!;
      expect(markdown).toContain("Project reference files (uploaded to this task's project):");
      expect(markdown).toContain('"filename":"notes-1.md"');
      expect(markdown).toContain('"contentPath":"/api/project-attachments/file-1/content"');
      expect(markdown).toContain("PAPERCLIP_API_KEY");
    });

    it("does not hand a native runner a download path it cannot use", () => {
      const markdown = buildPaperclipTaskMarkdown({ issue, nativeRunner: true, projectFiles: [file(1)] })!;
      expect(markdown).toContain('"filename":"notes-1.md"');
      expect(markdown).not.toContain("/api/project-attachments/");
      expect(markdown).toContain("read_task_attachment");
      expect(markdown).not.toContain("PAPERCLIP_API_KEY");
    });

    it("names the folder a file sits in, and omits it at the root", () => {
      const markdown = buildPaperclipTaskMarkdown({ issue, projectFiles: [{ ...file(1), folder: "docs/specs" }, file(2)] })!;
      expect(markdown).toContain('"filename":"notes-1.md","folder":"docs/specs"');
      expect(markdown).toContain('"filename":"notes-2.md","contentType"');
    });

    it("is omitted from a compact resume delta and when there are none", () => {
      expect(buildPaperclipTaskMarkdown({ issue, includeDescription: false, projectFiles: [file(1)] })).not.toContain("Project reference files");
      expect(buildPaperclipTaskMarkdown({ issue, projectFiles: [] })).not.toContain("Project reference files");
      expect(buildPaperclipTaskMarkdown({ issue })).not.toContain("Project reference files");
    });

    it("lists at most twenty and says how many were left out", () => {
      const markdown = buildPaperclipTaskMarkdown({ issue, projectFiles: Array.from({ length: 23 }, (_, i) => file(i + 1)) })!;
      expect(markdown).toContain("notes-20.md");
      expect(markdown).not.toContain("notes-21.md");
      expect(markdown).toContain("3 more project files are not listed here.");
    });
  });
});
