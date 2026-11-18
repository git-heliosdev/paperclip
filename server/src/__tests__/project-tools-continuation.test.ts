import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const base = {
  name: "continue_task",
  arguments: { reason: " Continue after repository setup ", requestKey: "continue-1" },
  apiUrl: "https://paperclip.example/api/",
  token: "run-token",
  companyId: "company-bound",
  issueId: "issue-bound",
  agentId: "agent-bound",
  conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project MCP continue_task", () => {
  it("exposes a strict continuation schema only in standard and skill-test task modes", () => {
    const standard = projectToolDefinitions("standard", true).find(tool => tool.name === "continue_task");
    const skillTest = projectToolDefinitions("skill_test", true).find(tool => tool.name === "continue_task");
    expect(standard).toBeDefined();
    expect(skillTest).toBeDefined();
    expect(standard?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["reason", "requestKey"],
      properties: { reason: expect.any(Object), requestKey: expect.any(Object) },
    });
    for (const mode of ["ask", "planning"]) {
      expect(projectToolDefinitions(mode, true).map(tool => tool.name)).not.toContain("continue_task");
    }
    expect(projectToolDefinitions("standard", false).map(tool => tool.name)).not.toContain("continue_task");
  });

  it("posts the bound agent and task using the short bearer and returns the queued receipt", async () => {
    const receipt = { status: "queued", runId: "run-queued", wakeupRequestId: "wake-1" };
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(receipt, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(callProjectTool(base)).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://paperclip.example/api/agents/agent-bound/wakeup");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer run-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "on_demand",
        triggerDetail: "callback",
        reason: "Continue after repository setup",
        idempotencyKey: "continue-task-v2:issue-bound:continue-1",
        forceFreshSession: true,
        payload: { issueId: "issue-bound" },
      }),
    });
  });

  it("keeps request keys task-scoped and returns skipped receipts as-is", async () => {
    const skipped = { status: "skipped", reason: "task_not_runnable" };
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(skipped, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(callProjectTool(base)).resolves.toEqual(skipped);
    await callProjectTool({ ...base, issueId: "another-issue" });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).idempotencyKey)
      .toBe("continue-task-v2:issue-bound:continue-1");
    expect(JSON.parse(fetcher.mock.calls[1]![1].body as string).idempotencyKey)
      .toBe("continue-task-v2:another-issue:continue-1");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).forceFreshSession).toBe(true);
  });

  it.each([
    { reason: "Continue", requestKey: "key-1", agentId: "agent-spoofed" },
    { reason: "Continue", requestKey: "key-1", issueId: "issue-spoofed" },
    { reason: "Continue", requestKey: "key-1", source: "assignment" },
    { reason: "Continue", requestKey: "key-1", triggerDetail: "manual" },
    { reason: "Continue", requestKey: "key-1", payload: { issueId: "issue-spoofed" } },
    { reason: "Continue", requestKey: "key-1", forceFreshSession: false },
    { reason: "  ", requestKey: "key-1" },
    { reason: "Continue", requestKey: "  " },
  ])("rejects untrusted or malformed arguments before fetching: %j", async arguments_ => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(callProjectTool({ ...base, arguments: arguments_ })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces existing API authorization denials", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init: RequestInit) => Response.json({ error: "Agent can only invoke itself" }, { status: 403 })));
    await expect(callProjectTool(base)).rejects.toThrow("Agent can only invoke itself");
  });
});
