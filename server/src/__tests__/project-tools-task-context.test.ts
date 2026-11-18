import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const base = {
  name: "get_task",
  arguments: {},
  apiUrl: "https://paperclip.example/api/",
  token: "run-token",
  companyId: "company-bound",
  issueId: "current-task",
  agentId: "agent-bound",
  conversation: false,
};
const otherTaskId = "c6ad3c8c-352a-4c44-a773-0b2e40b0d2f7";

afterEach(() => vi.unstubAllGlobals());

describe("project MCP task context tools", () => {
  it("exposes read tools in task context modes and restricts update_task to standard modes", () => {
    for (const mode of ["standard", "skill_test", "ask", "planning"]) {
      expect(projectToolDefinitions(mode, true).map(tool => tool.name)).toEqual(expect.arrayContaining([
        "get_task", "get_task_comments", "list_agents",
      ]));
    }
    for (const mode of ["standard", "skill_test"]) {
      expect(projectToolDefinitions(mode, true).map(tool => tool.name)).toEqual(expect.arrayContaining(["update_task", "add_task_comment"]));
    }
    for (const mode of ["ask", "planning"]) {
      expect(projectToolDefinitions(mode, true).map(tool => tool.name)).not.toContain("update_task");
      expect(projectToolDefinitions(mode, true).map(tool => tool.name)).not.toContain("add_task_comment");
    }
    expect(projectToolDefinitions("standard", false).map(tool => tool.name)).not.toContain("get_task");
    expect(projectToolDefinitions("standard", false).map(tool => tool.name)).not.toContain("add_task_comment");
  });

  it("reads the bound task by default and returns only the task summary", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: "current-task", companyId: "company-bound", identifier: "ONT-1", title: "Title", status: "todo",
      projectId: null, parentId: null, updatedAt: "2026-11-17T00:00:00Z", executionPolicy: { secret: true },
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool(base)).resolves.toEqual({
      id: "current-task", companyId: "company-bound", identifier: "ONT-1", title: "Title", status: "todo",
      projectId: null, parentId: null, updatedAt: "2026-11-17T00:00:00Z",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://paperclip.example/api/issues/current-task");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer run-token" } });
  });

  it("uses the explicit task id while preserving company scope and redacts agent responses", async () => {
    const fetcher = vi.fn(async () => Response.json([{ id: "agent-1", name: "Designer", role: "agent", status: "active", adapterConfig: { secret: "redacted" } }]));
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({ ...base, name: "list_agents" })).resolves.toEqual([
      { id: "agent-1", name: "Designer", role: "agent", status: "active" },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://paperclip.example/api/companies/company-bound/agents");

    fetcher.mockImplementationOnce(async () => Response.json([{ id: "comment-1", issueId: otherTaskId, body: "Review", createdAt: "2026-11-17", internalMetadata: "secret" }]));
    await expect(callProjectTool({ ...base, name: "get_task_comments", arguments: { taskId: otherTaskId } })).resolves.toEqual([
      { id: "comment-1", issueId: otherTaskId, body: "Review", createdAt: "2026-11-17" },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://paperclip.example/api/issues/${otherTaskId}/comments`);
  });

  it("patches only status/projectId through the authenticated issue route", async () => {
    const receipt = { id: "current-task", status: "in_review", projectId: null };
    const fetcher = vi.fn(async () => Response.json(receipt));
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({ ...base, name: "update_task", arguments: { status: "in_review", projectId: null } })).resolves.toEqual(receipt);
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/issues/current-task", expect.objectContaining({
      method: "PATCH",
      headers: { Authorization: "Bearer run-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_review", projectId: null }),
    })]);
  });

  it("posts only the plain-text body through the authorized task comment route", async () => {
    const receipt = { id: "comment-1", issueId: otherTaskId, body: "Source material attached", createdAt: "2026-11-17", privateMetadata: "not forwarded" };
    const fetcher = vi.fn(async () => Response.json(receipt, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({
      ...base, name: "add_task_comment", arguments: { taskId: otherTaskId, body: "  Source material attached  " },
    })).resolves.toEqual({ id: "comment-1", issueId: otherTaskId, body: "Source material attached", createdAt: "2026-11-17" });
    expect(fetcher.mock.calls[0]).toEqual([`https://paperclip.example/api/issues/${otherTaskId}/comments`, expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer run-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Source material attached" }),
    })]);
  });

  it.each([
    { name: "update_task", arguments: {} },
    { name: "update_task", arguments: { status: "invalid" } },
    { name: "update_task", arguments: { projectId: "not-a-uuid" } },
    { name: "update_task", arguments: { status: "todo", assigneeAgentId: "agent-spoof" } },
    { name: "add_task_comment", arguments: { body: "Hello", onBehalfOfUserId: "user-spoof" } },
    { name: "add_task_comment", arguments: { body: "  " } },
    { name: "add_task_comment", arguments: { body: "x".repeat(32_001) } },
    { name: "get_task", arguments: { taskId: otherTaskId, companyId: "other-company" } },
    { name: "get_task_comments", arguments: { taskId: "not-a-uuid" } },
    { name: "list_agents", arguments: { companyId: "other-company" } },
  ])("rejects invalid or overbroad arguments before the API call: %j", async tool => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({ ...base, ...tool })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces normal API authorization and validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Task access denied" }, { status: 403 })));
    await expect(callProjectTool({ ...base, name: "add_task_comment", arguments: { body: "Unauthorized comment" } })).rejects.toThrow("Task access denied");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Invalid project" }, { status: 400 })));
    await expect(callProjectTool({ ...base, name: "update_task", arguments: { projectId: null } })).rejects.toThrow("Invalid project");
  });

  it("fails closed if agent or comment routes return an unexpected non-array shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [{ id: "agent-1", adapterConfig: { secret: true } }] })));
    await expect(callProjectTool({ ...base, name: "list_agents" })).rejects.toThrow("Unexpected agent list response");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ comments: [{ body: "private" }] })));
    await expect(callProjectTool({ ...base, name: "get_task_comments" })).rejects.toThrow("Unexpected task comments response");
  });
});
