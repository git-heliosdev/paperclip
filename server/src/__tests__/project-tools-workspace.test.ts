import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const base = {
  name: "get_workspace",
  arguments: {},
  apiUrl: "https://paperclip.example/api",
  token: "run-token",
  companyId: "company",
  issueId: "current-task",
  agentId: "agent",
  conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project MCP task workspace tools", () => {
  it("exposes only workspace operations allowed in each task mode", () => {
    const names = (mode: string) => projectToolDefinitions(mode, true).map(tool => tool.name);
    expect(names("standard")).toEqual(expect.arrayContaining([
      "get_workspace", "list_workspaces", "select_workspace", "prepare_repository",
    ]));
    for (const mode of ["ask", "planning"]) {
      expect(names(mode)).toEqual(expect.arrayContaining(["get_workspace", "list_workspaces"]));
      expect(names(mode)).not.toContain("select_workspace");
      expect(names(mode)).not.toContain("prepare_repository");
    }
    expect(names("skill_test")).toEqual(expect.arrayContaining([
      "get_workspace", "list_workspaces", "select_workspace", "prepare_repository",
    ]));
    const withoutTaskTools = projectToolDefinitions("standard", false).map(tool => tool.name);
    for (const tool of ["get_workspace", "list_workspaces", "select_workspace", "prepare_repository"]) {
      expect(withoutTaskTools).not.toContain(tool);
    }
  });

  it("reads and writes through the active task workspace routes", async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => Response.json({
      issueId: "current-task", bindingRevision: 4, workspace: null, repositories: [],
    }));
    vi.stubGlobal("fetch", fetcher);
    await callProjectTool(base);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://paperclip.example/api/issues/current-task/workspace");

    fetcher.mockImplementationOnce(async (_url: string, _options: RequestInit) => Response.json({ kind: "scheduled" }));
    const body = { selection: { kind: "task_directory" }, expectedBindingRevision: 4, requestKey: "select-4" };
    await expect(callProjectTool({ ...base, name: "select_workspace", arguments: body })).resolves.toEqual({ kind: "scheduled" });
    expect(fetcher.mock.calls[1]).toEqual([
      "https://paperclip.example/api/issues/current-task/workspace",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(body) }),
    ]);
  });

  it("uses the current task for workspace reads and repository preparation", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => Response.json({
        issueId: "current-task", bindingRevision: 2, workspace: null, repositories: [],
      }))
      .mockImplementationOnce(async () => Response.json({
        operationId: "preparation-123", kind: "requires_next_admission",
        repository: { id: "repo-1", repoUrl: "https://github.com/acme/site", relativePath: "site", state: "ready" },
      }));
    vi.stubGlobal("fetch", fetcher);
    await callProjectTool({ ...base, arguments: { issueId: "other-task" } });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://paperclip.example/api/issues/current-task/workspace");

    const args = { repository: { kind: "catalog", id: "repo-1" }, requestKey: "prepare-1" };
    await expect(callProjectTool({ ...base, name: "prepare_repository", arguments: args })).resolves.toMatchObject({
      kind: "requires_next_admission", preparationId: "preparation-123",
      repository: { id: "repo-1", repoUrl: "https://github.com/acme/site" },
    });
    expect(fetcher.mock.calls[1]).toEqual([
      "https://paperclip.example/api/issues/current-task/workspace/repositories",
      expect.objectContaining({ method: "POST", body: JSON.stringify(args) }),
    ]);
  });

  it("rejects malformed selection arguments before making a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({
      ...base,
      name: "select_workspace",
      arguments: { selection: { kind: "task_directory" }, expectedBindingRevision: -1, requestKey: "bad", issueId: "other-task" },
    })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces API authorization errors without converting them to success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Not authorized for this workspace" }, { status: 403 })));
    await expect(callProjectTool({ ...base, name: "get_workspace" })).rejects.toThrow("Not authorized for this workspace");
  });

  it("does not expose metadata-only workspace mutation or discovery tools", () => {
    const names = projectToolDefinitions("standard", true).map(tool => tool.name);
    expect(names).not.toContain("update_workspace");
    expect(names).not.toContain("create_workspace");
    expect(names).not.toContain("list_project_workspaces");
  });
});
