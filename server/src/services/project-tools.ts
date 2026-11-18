import { projectDiscoverySchema, createProjectSchema, createIssueSchema, setIssueTitleSchema, ISSUE_STATUSES } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";
import { callTaskWorkspaceTool } from "./task-workspace-tools.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
const TASK_TOOL_NAMES = ["create_task", "set_task_title", "get_workspace", "list_workspaces", "select_workspace", "prepare_repository"];
const TASK_WORKSPACE_TOOL_NAMES = new Set(["get_workspace", "list_workspaces", "select_workspace", "prepare_repository"]);
const taskIdSchema = z.string().uuid().optional();
const taskReadSchema = z.object({ taskId: taskIdSchema }).strict();
const listAgentsSchema = z.object({}).strict();
const updateTaskFieldsSchema = z.object({
  taskId: taskIdSchema,
  status: z.enum(ISSUE_STATUSES).optional(),
  projectId: z.string().uuid().nullable().optional(),
}).strict();
const updateTaskSchema = updateTaskFieldsSchema.refine(
  (value) => value.status !== undefined || value.projectId !== undefined,
  "Provide status or projectId",
);
const taskContextToolDefinitions = [
  { name: "get_task", description: "Read the current task or another task in this company. Returns a compact task summary.", inputSchema: z.toJSONSchema(taskReadSchema) },
  { name: "get_task_comments", description: "Read comments on the current task or another task in this company.", inputSchema: z.toJSONSchema(taskReadSchema) },
  { name: "list_agents", description: "List agents in the current company by id, name, role, and status.", inputSchema: z.toJSONSchema(listAgentsSchema) },
];
const updateTaskInputSchema = {
  ...z.toJSONSchema(updateTaskFieldsSchema),
  anyOf: [{ required: ["status"] }, { required: ["projectId"] }],
};
const updateTaskTool = {
  name: "update_task",
  description: "Update the current task or another task in this company. Only status and projectId can be changed.",
  inputSchema: updateTaskInputSchema,
};
const continueTaskSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(1).max(150),
}).strict();
const continueTaskTool = {
  name: "continue_task",
  description: "Queue an on-demand continuation for the active task after making concrete progress. The existing scheduler decides when it can run; this does not bypass task blockers or execution policy. Reuse requestKey if retrying the same continuation.",
  inputSchema: z.toJSONSchema(continueTaskSchema),
};

export function projectToolDefinitions(workMode: string, includeTask = false) {
  const definitions = CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && TASK_TOOL_NAMES.includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard" | "ask" | "planning" | "skill_test"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.inputSchema,
  }));
  if (!includeTask || !["standard", "skill_test", "ask", "planning"].includes(workMode)) return definitions;
  const withReadTools = [...definitions, ...taskContextToolDefinitions];
  return ["standard", "skill_test"].includes(workMode)
    ? [...withReadTools, updateTaskTool, continueTaskTool]
    : withReadTools;
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  if (["get_task", "get_task_comments", "list_agents", "update_task"].includes(input.name)) {
    if (input.name === "list_agents") listAgentsSchema.parse(args);
    const taskId = input.name === "list_agents" ? input.issueId
      : input.name === "update_task" ? updateTaskSchema.parse(args).taskId ?? input.issueId
        : taskReadSchema.parse(args).taskId ?? input.issueId;
    const baseUrl = `${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api`;
    const path = input.name === "list_agents" ? `/companies/${encodeURIComponent(input.companyId)}/agents`
      : input.name === "get_task_comments" ? `/issues/${encodeURIComponent(taskId)}/comments`
        : input.name === "get_task" ? `/issues/${encodeURIComponent(taskId)}`
          : `/issues/${encodeURIComponent(taskId)}`;
    const response = await fetch(`${baseUrl}${path}`, {
      method: input.name === "update_task" ? "PATCH" : "GET",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      ...(input.name === "update_task" ? (() => {
        const update = updateTaskSchema.parse(args);
        return { body: JSON.stringify({
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(update.projectId !== undefined ? { projectId: update.projectId } : {}),
        }) };
      })() : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Task tool failed (${response.status})`);
    if (input.name === "list_agents") {
      if (!Array.isArray(result)) throw new Error("Unexpected agent list response");
      return result.map((agent: Record<string, unknown>) => Object.fromEntries(
        ["id", "name", "role", "status"].filter(key => agent[key] !== undefined).map(key => [key, agent[key]]),
      ));
    }
    if (input.name === "get_task_comments") {
      if (!Array.isArray(result)) throw new Error("Unexpected task comments response");
      return result.map((comment: Record<string, unknown>) => Object.fromEntries(
        ["id", "issueId", "body", "createdAt", "authorAgentId", "authorUserId"]
          .filter(key => comment[key] !== undefined).map(key => [key, comment[key]]),
      ));
    }
    if (input.name === "get_task") return Object.fromEntries([
      "id", "companyId", "identifier", "title", "description", "status", "priority", "assigneeAgentId",
      "assigneeUserId", "projectId", "parentId", "updatedAt", "completedAt",
    ].filter(key => key in result).map(key => [key, result[key]]));
    return result;
  }
  if (TASK_WORKSPACE_TOOL_NAMES.has(input.name)) {
    return callTaskWorkspaceTool({
      name: input.name,
      arguments: args,
      apiUrl: input.apiUrl,
      token: input.token,
      companyId: input.companyId,
      issueId: input.issueId,
    });
  }
  if (input.name === "continue_task") {
    const continuation = continueTaskSchema.parse(args);
    const path = `/agents/${encodeURIComponent(input.agentId)}/wakeup`;
    const body = {
      source: "on_demand",
      triggerDetail: "callback",
      reason: continuation.reason,
      idempotencyKey: `continue-task:${input.issueId}:${continuation.requestKey}`,
      payload: { issueId: input.issueId },
    };
    const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Task continuation failed (${response.status})`);
    return result;
  }
  const page = input.name === "list_projects" ? projectDiscoverySchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
    body = setIssueTitleSchema.parse(args);
  } else if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (page) {
    const query = new URLSearchParams({ view: "summary", limit: String(page.limit) });
    if (page.cursor) query.set("cursor", page.cursor);
    path += `?${query}`;
  }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: input.name === "set_task_title" ? "PUT" : body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return result;
}
