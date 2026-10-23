// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRepository } from "@paperclipai/shared";
import { RepositoryEditor } from "./RepositoryEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(() => {
    callback();
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

describe("RepositoryEditor", () => {
  it("offers GitHub, GitLab and Gitea when no Git host is connected", () => {
    const onConnect = vi.fn();
    act(() => root.render(<RepositoryEditor selected={[]} onChange={vi.fn()} state="disconnected" onConnect={onConnect} onRetry={vi.fn()} />));
    act(() => button("Add repo")!.click());
    expect(document.body.textContent).toContain("Connect a Git host to pick a repo");
    for (const label of ["Connect GitHub", "Connect GitLab", "Connect Gitea"]) expect(button(label), label).toBeTruthy();
    act(() => button("Connect GitLab")!.click());
    expect(onConnect).toHaveBeenCalledWith("gitlab");
  });

  it("marks each selected repository with its provider", () => {
    const selected: ProjectRepository[] = [
      { id: "1", fullName: "acme/web", url: "https://github.com/acme/web", connections: ["GitHub"] },
      { id: "gitlab:gitlab.example.com:5", fullName: "group/sub/api", url: "https://gitlab.example.com/group/sub/api", provider: "gitlab", connections: ["Company GitLab"], private: true },
      { id: "gitea:codeberg.org:9", fullName: "team/tool", url: "https://codeberg.org/team/tool", provider: "gitea", connections: ["Codeberg"] },
    ];
    act(() => root.render(<RepositoryEditor selected={selected} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
    const icons = [...container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(icons).toEqual(["/brands/apps/gitlab.svg", "/brands/apps/gitea.svg"]);
    expect(container.textContent).toContain("group/sub/api");
    expect(container.querySelector('[aria-label="Private repository"]')).not.toBeNull();
    expect(button("Add another repo")).toBeTruthy();
  });
});
