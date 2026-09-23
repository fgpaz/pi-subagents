/**
 * Mutation-capable children must not receive hard turn or tool-call caps.
 * Keep wall timeout, token/cost/usage, permissions, tools, concurrency and
 * lifecycle controls intact. Read-only scouts may retain count budgets.
 */
import type { AgentConfig } from "../../agents/agents.ts";
import type { ToolBudgetConfig } from "../../shared/types.ts";
import { classifyTaskMutationIntent, taskMayMutate } from "./task-intent.ts";

type TurnBudgetConfig = Record<string, unknown>;
export type WriterBudgetStripReason = "mutation_agent_name" | "writer_acceptance_role" | "mutation_tools" | "implementation_task" | "mixed_run_includes_writer";
export interface WriterBudgetStripEvent { field: "turnBudget" | "toolBudget" | "defaultTurnBudget"; agent?: string; reason: WriterBudgetStripReason; }
export interface WriterBudgetPolicyResult<T> { params: T; stripped: WriterBudgetStripEvent[]; }

const MUTATION_NAME_RE = /\b(?:worker|writer|delegate|implementer|fixer|coder|editor|mi-pi-(?:degraded-)?writer|mi-pi-prepared-worker)\b/i;
const READ_ONLY_NAME_RE = /\b(?:scout|reviewer|researcher|explorer|oracle|analyst|context-builder|awaiter|advisor)\b/i;
const MUTATION_TOOL_NAMES = new Set(["edit", "write", "bash", "apply_patch", "str_replace", "create_file", "delete_file", "notebook_edit"]);

export function agentLooksMutationCapable(input: { agentName: string; acceptanceRole?: AgentConfig["acceptanceRole"]; tools?: string[] | false; task?: string }): boolean {
  const name = input.agentName.trim();
  const lower = name.toLowerCase();
  const task = input.task ?? "";
  const intent = classifyTaskMutationIntent(name, task);
  if (input.acceptanceRole === "read-only" && intent.kind !== "implementation" && !taskMayMutate(task)) return false;
  if (input.acceptanceRole === "writer" || MUTATION_NAME_RE.test(lower)) return true;
  if (READ_ONLY_NAME_RE.test(lower) && intent.kind !== "implementation" && !taskMayMutate(task)) return false;
  if (intent.kind === "implementation" || taskMayMutate(task)) return true;
  if (Array.isArray(input.tools) && input.tools.some((tool) => MUTATION_TOOL_NAMES.has(String(tool).toLowerCase()))) return true;
  return input.tools === undefined && !READ_ONLY_NAME_RE.test(lower) && (intent.kind === "unknown" || !lower);
}

function findAgent(agents: AgentConfig[], name: string | undefined): AgentConfig | undefined { return name ? agents.find((agent) => agent.name === name) : undefined; }
function hardToolBudget(value: unknown): value is ToolBudgetConfig { return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as ToolBudgetConfig).hard === "number"); }

export function applyWriterBudgetPolicy<T>(params: T, agents: AgentConfig[]): WriterBudgetPolicyResult<T> {
  const stripped: WriterBudgetStripEvent[] = [];
  const isWriter = (agentName: string, task?: string) => { const agent = findAgent(agents, agentName); return agentLooksMutationCapable({ agentName, acceptanceRole: agent?.acceptanceRole, tools: agent?.tools, task }); };
  type PolicyTask = { agent?: unknown; task?: unknown; toolBudget?: unknown; [key: string]: unknown };
  type PolicyStep = PolicyTask & { parallel?: unknown };
  const input = params as T & { agent?: unknown; task?: unknown; turnBudget?: unknown; toolBudget?: unknown; tasks?: unknown; chain?: unknown };
  const tasks = Array.isArray(input.tasks) ? input.tasks as PolicyTask[] : [];
  const chain = Array.isArray(input.chain) ? input.chain as PolicyStep[] : [];
  const launchIsWriter = Boolean((typeof input.agent === "string" && isWriter(input.agent, typeof input.task === "string" ? input.task : undefined)) || tasks.some((task) => typeof task.agent === "string" && isWriter(task.agent, typeof task.task === "string" ? task.task : undefined)) || chain.some((step) => {
    if (typeof step.agent === "string" && isWriter(step.agent, typeof step.task === "string" ? step.task : undefined)) return true;
    return Array.isArray(step.parallel) && step.parallel.some((item) => item && typeof item === "object" && typeof (item as PolicyTask).agent === "string" && isWriter((item as PolicyTask).agent as string, typeof (item as PolicyTask).task === "string" ? (item as PolicyTask).task as string : undefined));
  }));
  if (!launchIsWriter) return { params, stripped };
  let next: T = { ...params };
  const mutable = next as T & { agent?: string; turnBudget?: unknown; toolBudget?: unknown; tasks?: unknown; chain?: unknown };
  if (mutable.turnBudget !== undefined) { const { turnBudget: _removed, ...rest } = mutable; next = rest as T; stripped.push({ field: "turnBudget", agent: mutable.agent, reason: "mixed_run_includes_writer" }); }
  const current = next as T & { agent?: string; toolBudget?: unknown; tasks?: unknown; chain?: unknown };
  if (hardToolBudget(current.toolBudget)) { const { toolBudget: _removed, ...rest } = current; next = rest as T; stripped.push({ field: "toolBudget", agent: current.agent, reason: "mixed_run_includes_writer" }); }
  const withoutRootBudget = next as T & { tasks?: unknown; chain?: unknown };
  if (Array.isArray(withoutRootBudget.tasks)) next = { ...withoutRootBudget, tasks: withoutRootBudget.tasks.map((value) => {
    const task = value as PolicyTask;
    if (typeof task.agent !== "string" || !isWriter(task.agent, typeof task.task === "string" ? task.task : undefined) || !hardToolBudget(task.toolBudget)) return value;
    const { toolBudget: _removed, ...rest } = task;
    stripped.push({ field: "toolBudget", agent: task.agent, reason: "mutation_agent_name" });
    return rest;
  }) } as T;
  const withoutTaskBudgets = next as T & { chain?: unknown };
  if (Array.isArray(withoutTaskBudgets.chain)) next = { ...withoutTaskBudgets, chain: withoutTaskBudgets.chain.map((value) => {
    const step = value as PolicyStep;
    let row: PolicyStep = { ...step };
    if (typeof row.agent === "string" && isWriter(row.agent, typeof row.task === "string" ? row.task : undefined) && hardToolBudget(row.toolBudget)) { const { toolBudget: _removed, ...rest } = row; row = rest; stripped.push({ field: "toolBudget", agent: step.agent as string, reason: "mutation_agent_name" }); }
    if (Array.isArray(row.parallel)) row.parallel = row.parallel.map((value) => {
      if (!value || typeof value !== "object") return value;
      const item = value as PolicyTask;
      if (typeof item.agent !== "string" || !isWriter(item.agent, typeof item.task === "string" ? item.task : undefined) || !hardToolBudget(item.toolBudget)) return value;
      const { toolBudget: _removed, ...rest } = item;
      stripped.push({ field: "toolBudget", agent: item.agent, reason: "mutation_agent_name" });
      return rest;
    });
    return row;
  }) } as T;
  return { params: next, stripped };
}
export function shouldSkipDefaultTurnBudget(agent: AgentConfig | undefined, task?: string): boolean { return Boolean(agent && agentLooksMutationCapable({ agentName: agent.name, acceptanceRole: agent.acceptanceRole, tools: agent.tools, task })); }
export function shouldSkipConfigTurnBudget(params: { agent?: string; task?: string; tasks?: Array<{ agent: string; task?: string }>; chain?: Array<Record<string, unknown>> }, agents: AgentConfig[]): boolean {
  return applyWriterBudgetPolicy(params, agents).stripped.some((event) => event.field === "turnBudget");
}
export function formatWriterBudgetStripNote(stripped: WriterBudgetStripEvent[]): string | undefined { return stripped.length ? "writer-budget-policy: stripped " + [...new Set(stripped.map((item) => item.field))].join("+") + " for mutation-capable launch" : undefined; }
export function formatPartialDeliveryTurnBudgetMessage(baseMessage: string, observedMutation: boolean): string {
  return observedMutation ? baseMessage + "\npartial_delivery: file mutations were observed before the legacy turn-budget abort. Resume only the remaining gap; do not put turnBudget/hard toolBudget on mutation workers." : baseMessage;
}
