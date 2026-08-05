/**
 * Runtime enforcement: mutation-capable children must not receive hard turn or
 * tool-call caps. Orchestrators often ignore prompt guidance and pass
 * turnBudget/toolBudget on writers; count limits abort real delivery slices.
 *
 * Bound writers with task scope + elapsed timeoutMs/maxRuntimeMs + checkpoints.
 * Keep turn/tool budgets for explicitly read-only scouts/reviewers/validators.
 */
import type { AcceptanceRole, AgentConfig, ToolBudgetConfig, TurnBudgetConfig } from "../../shared/types.ts";
import { classifyTaskMutationIntent, taskMayMutate } from "./task-intent.ts";

const MUTATION_NAME_RE =
	/\b(?:worker|writer|delegate|implementer|fixer|coder|editor|mi-pi-(?:degraded-)?writer|mi-pi-prepared-worker)\b/i;

const READ_ONLY_NAME_RE =
	/\b(?:scout|reviewer|researcher|explorer|oracle|analyst|context-builder|awaiter|advisor)\b/i;

const MUTATION_TOOL_NAMES = new Set([
	"edit",
	"write",
	"bash",
	"apply_patch",
	"str_replace",
	"create_file",
	"delete_file",
	"notebook_edit",
]);

export type WriterBudgetStripReason =
	| "mutation_agent_name"
	| "writer_acceptance_role"
	| "mutation_tools"
	| "implementation_task"
	| "mixed_run_includes_writer";

export interface WriterBudgetStripEvent {
	field: "turnBudget" | "toolBudget" | "defaultTurnBudget";
	agent?: string;
	reason: WriterBudgetStripReason;
}

export interface WriterBudgetPolicyResult<T> {
	params: T;
	stripped: WriterBudgetStripEvent[];
}

export function agentLooksMutationCapable(input: {
	agentName: string;
	acceptanceRole?: AcceptanceRole;
	tools?: string[] | false | undefined;
	task?: string;
}): boolean {
	const name = input.agentName.trim();
	const lower = name.toLowerCase();
	const intent = classifyTaskMutationIntent(name, input.task ?? "");

	if (input.acceptanceRole === "read-only" && intent.kind !== "implementation" && !taskMayMutate(input.task ?? "")) {
		return false;
	}
	if (input.acceptanceRole === "writer") return true;
	if (MUTATION_NAME_RE.test(lower)) return true;
	if (READ_ONLY_NAME_RE.test(lower) && intent.kind !== "implementation" && !taskMayMutate(input.task ?? "")) {
		return false;
	}
	if (intent.kind === "implementation" || taskMayMutate(input.task ?? "")) return true;

	const tools = input.tools;
	if (Array.isArray(tools) && tools.some((tool) => MUTATION_TOOL_NAMES.has(String(tool).toLowerCase()))) {
		return true;
	}
	// Omitted tools => child inherits full Pi builtins (mutation-capable).
	if (tools === undefined && !READ_ONLY_NAME_RE.test(lower)) {
		// Unknown custom agents default to mutation-capable when not clearly read-only.
		if (!READ_ONLY_NAME_RE.test(lower) && (intent.kind === "unknown" || !lower)) return true;
	}
	return false;
}

function findAgent(agents: AgentConfig[], name: string | undefined): AgentConfig | undefined {
	if (!name) return undefined;
	return agents.find((agent) => agent.name === name);
}

function launchIncludesMutationAgent(
	params: {
		agent?: string;
		task?: string;
		tasks?: Array<{ agent: string; task?: string; toolBudget?: ToolBudgetConfig }>;
		chain?: Array<Record<string, unknown>>;
	},
	agents: AgentConfig[],
): { mutation: boolean; reasons: WriterBudgetStripEvent[] } {
	const reasons: WriterBudgetStripEvent[] = [];
	const note = (agent: string, reason: WriterBudgetStripReason) => {
		reasons.push({ field: "turnBudget", agent, reason });
	};

	const consider = (agentName: string, task?: string) => {
		const agent = findAgent(agents, agentName);
		const capable = agentLooksMutationCapable({
			agentName,
			acceptanceRole: agent?.acceptanceRole,
			tools: agent?.tools,
			task,
		});
		if (!capable) return false;
		if (agent?.acceptanceRole === "writer") note(agentName, "writer_acceptance_role");
		else if (MUTATION_NAME_RE.test(agentName)) note(agentName, "mutation_agent_name");
		else if (classifyTaskMutationIntent(agentName, task ?? "").kind === "implementation" || taskMayMutate(task ?? "")) {
			note(agentName, "implementation_task");
		} else note(agentName, "mutation_tools");
		return true;
	};

	let mutation = false;
	if (params.agent && consider(params.agent, params.task)) mutation = true;
	for (const task of params.tasks ?? []) {
		if (consider(task.agent, task.task)) mutation = true;
	}
	for (const step of params.chain ?? []) {
		if (typeof step.agent === "string" && consider(step.agent, typeof step.task === "string" ? step.task : undefined)) {
			mutation = true;
		}
		const parallel = step.parallel;
		if (Array.isArray(parallel)) {
			for (const item of parallel) {
				if (!item || typeof item !== "object") continue;
				const row = item as { agent?: string; task?: string };
				if (typeof row.agent === "string" && consider(row.agent, row.task)) mutation = true;
			}
		}
	}
	if (mutation && reasons.length > 1) {
		// Collapse multi-agent to a mixed-run marker for run-level strips.
		reasons.push({ field: "turnBudget", reason: "mixed_run_includes_writer" });
	}
	return { mutation, reasons };
}

/** True when toolBudget is a hard count cap (always is when present). */
export function isHardToolBudget(budget: unknown): budget is ToolBudgetConfig {
	return Boolean(budget && typeof budget === "object" && !Array.isArray(budget) && typeof (budget as ToolBudgetConfig).hard === "number");
}

/**
 * Strip turnBudget and hard toolBudget from mutation-capable launches.
 * Also clears agent defaultTurnBudget application by deleting caller turnBudget
 * before defaults merge when the single agent is a writer (call after defaults
 * or pass pre-default params + re-apply).
 */
export function applyWriterBudgetPolicy<T extends {
	agent?: string;
	task?: string;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	tasks?: Array<{ agent: string; task?: string; toolBudget?: ToolBudgetConfig } & Record<string, unknown>>;
	chain?: Array<Record<string, unknown>>;
}>(params: T, agents: AgentConfig[]): WriterBudgetPolicyResult<T> {
	const stripped: WriterBudgetStripEvent[] = [];
	const { mutation, reasons } = launchIncludesMutationAgent(params, agents);
	if (!mutation) return { params, stripped };

	let next: T = { ...params };

	if (next.turnBudget !== undefined) {
		const { turnBudget: _removed, ...rest } = next as T & { turnBudget?: TurnBudgetConfig };
		next = rest as T;
		stripped.push(...reasons.map((r) => ({ ...r, field: "turnBudget" as const })));
		if (stripped.length === 0) stripped.push({ field: "turnBudget", reason: "mixed_run_includes_writer" });
	}

	if (isHardToolBudget(next.toolBudget)) {
		const { toolBudget: _removed, ...rest } = next as T & { toolBudget?: ToolBudgetConfig };
		next = rest as T;
		stripped.push({
			field: "toolBudget",
			agent: next.agent,
			reason: reasons[0]?.reason ?? "mixed_run_includes_writer",
		});
	}

	if (Array.isArray(next.tasks) && next.tasks.length > 0) {
		const tasks = next.tasks.map((task) => {
			const agent = findAgent(agents, task.agent);
			const capable = agentLooksMutationCapable({
				agentName: task.agent,
				acceptanceRole: agent?.acceptanceRole,
				tools: agent?.tools,
				task: task.task,
			});
			if (!capable || !isHardToolBudget(task.toolBudget)) return task;
			const { toolBudget: _removed, ...rest } = task;
			stripped.push({ field: "toolBudget", agent: task.agent, reason: "mutation_agent_name" });
			return rest as typeof task;
		});
		next = { ...next, tasks };
	}

	if (Array.isArray(next.chain) && next.chain.length > 0) {
		const chain = next.chain.map((step) => {
			let row = { ...step };
			const agentName = typeof row.agent === "string" ? row.agent : undefined;
			if (agentName) {
				const agent = findAgent(agents, agentName);
				const capable = agentLooksMutationCapable({
					agentName,
					acceptanceRole: agent?.acceptanceRole,
					tools: agent?.tools,
					task: typeof row.task === "string" ? row.task : undefined,
				});
				if (capable && isHardToolBudget(row.toolBudget)) {
					const { toolBudget: _removed, ...rest } = row;
					row = rest;
					stripped.push({ field: "toolBudget", agent: agentName, reason: "mutation_agent_name" });
				}
			}
			if (Array.isArray(row.parallel)) {
				row = {
					...row,
					parallel: row.parallel.map((item) => {
						if (!item || typeof item !== "object") return item;
						const task = item as { agent?: string; task?: string; toolBudget?: ToolBudgetConfig };
						if (typeof task.agent !== "string" || !isHardToolBudget(task.toolBudget)) return item;
						const agent = findAgent(agents, task.agent);
						const capable = agentLooksMutationCapable({
							agentName: task.agent,
							acceptanceRole: agent?.acceptanceRole,
							tools: agent?.tools,
							task: task.task,
						});
						if (!capable) return item;
						const { toolBudget: _removed, ...rest } = task;
						stripped.push({ field: "toolBudget", agent: task.agent, reason: "mutation_agent_name" });
						return rest;
					}),
				};
			}
			return row;
		});
		next = { ...next, chain };
	}

	return { params: next, stripped };
}

/** Skip agent/config default turn budgets for mutation-capable single agents. */
export function shouldSkipDefaultTurnBudget(agent: AgentConfig | undefined, task?: string): boolean {
	if (!agent) return false;
	return agentLooksMutationCapable({
		agentName: agent.name,
		acceptanceRole: agent.acceptanceRole,
		tools: agent.tools,
		task,
	});
}

/** Skip config-level turnBudget when the launch includes a writer. */
export function shouldSkipConfigTurnBudget(params: {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task?: string }>;
	chain?: Array<Record<string, unknown>>;
}, agents: AgentConfig[]): boolean {
	return launchIncludesMutationAgent(params, agents).mutation;
}

export function formatWriterBudgetStripNote(stripped: WriterBudgetStripEvent[]): string | undefined {
	if (stripped.length === 0) return undefined;
	const fields = [...new Set(stripped.map((s) => s.field))].join("+");
	const agents = [...new Set(stripped.map((s) => s.agent).filter(Boolean))].join(", ");
	return `writer-budget-policy: stripped ${fields}${agents ? ` for ${agents}` : ""} (mutation-capable launch; use timeoutMs + task scope instead of turn/tool count caps)`;
}

/**
 * When a turn budget still fires (legacy path) but the child mutated files,
 * surface partial-delivery guidance so parents resume gaps instead of full redo.
 */
export function formatPartialDeliveryTurnBudgetMessage(baseMessage: string, observedMutation: boolean): string {
	if (!observedMutation) return baseMessage;
	return (
		`${baseMessage}\n` +
		"partial_delivery: file mutations were observed before the turn budget abort. " +
		"Treat changed paths as lane progress; resume with a gap-only leaf instead of redoing the full task. " +
		"Do not put turnBudget/hard toolBudget on mutation workers."
	);
}
