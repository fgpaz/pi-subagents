import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/shared/types.ts";
import {
	agentLooksMutationCapable,
	applyWriterBudgetPolicy,
	formatPartialDeliveryTurnBudgetMessage,
	shouldSkipConfigTurnBudget,
	shouldSkipDefaultTurnBudget,
} from "../../src/runs/shared/writer-budget-policy.ts";

const agent = (name: string, patch: Partial<AgentConfig> = {}): AgentConfig =>
	({
		name,
		description: name,
		systemPrompt: "",
		...patch,
	}) as AgentConfig;

describe("writer-budget-policy", () => {
	it("detects mutation-capable workers and writers by name/role/task", () => {
		assert.equal(agentLooksMutationCapable({ agentName: "worker", task: "implement the fix" }), true);
		assert.equal(agentLooksMutationCapable({ agentName: "mi-pi-degraded-writer" }), true);
		assert.equal(agentLooksMutationCapable({ agentName: "custom", acceptanceRole: "writer" }), true);
		assert.equal(agentLooksMutationCapable({ agentName: "scout", task: "list files only, read-only" }), false);
		assert.equal(agentLooksMutationCapable({ agentName: "reviewer", acceptanceRole: "read-only", task: "review only" }), false);
		assert.equal(
			agentLooksMutationCapable({
				agentName: "helper",
				tools: ["edit", "read"],
				task: "apply the patch",
			}),
			true,
		);
	});

	it("strips turnBudget and hard toolBudget from writer launches", () => {
		const agents = [agent("worker"), agent("scout", { acceptanceRole: "read-only", tools: ["read", "grep"] })];
		const { params, stripped } = applyWriterBudgetPolicy(
			{
				agent: "worker",
				task: "Implement recovery UI",
				turnBudget: { maxTurns: 44, graceTurns: 5 },
				toolBudget: { hard: 120, soft: 75, block: "*" },
			},
			agents,
		);
		assert.equal(params.turnBudget, undefined);
		assert.equal(params.toolBudget, undefined);
		assert.ok(stripped.some((event) => event.field === "turnBudget"));
		assert.ok(stripped.some((event) => event.field === "toolBudget"));
	});

	it("keeps budgets on pure scout launches", () => {
		const agents = [agent("scout", { acceptanceRole: "read-only", tools: ["read", "grep", "find"] })];
		const input = {
			agent: "scout",
			task: "Read-only inventory of auth paths",
			turnBudget: { maxTurns: 12, graceTurns: 2 },
			toolBudget: { hard: 40, soft: 20 },
		};
		const { params, stripped } = applyWriterBudgetPolicy(input, agents);
		assert.deepEqual(params.turnBudget, input.turnBudget);
		assert.deepEqual(params.toolBudget, input.toolBudget);
		assert.equal(stripped.length, 0);
	});

	it("strips run-level turnBudget when parallel includes a writer", () => {
		const agents = [agent("worker"), agent("scout", { acceptanceRole: "read-only", tools: ["read"] })];
		const { params, stripped } = applyWriterBudgetPolicy(
			{
				tasks: [
					{ agent: "scout", task: "map files read-only" },
					{ agent: "worker", task: "implement the approved fix", toolBudget: { hard: 50 } },
				],
				turnBudget: { maxTurns: 20, graceTurns: 3 },
			},
			agents,
		);
		assert.equal(params.turnBudget, undefined);
		assert.equal(params.tasks?.[1]?.toolBudget, undefined);
		assert.ok(params.tasks?.[0]); // scout task kept
		assert.ok(stripped.length > 0);
	});

	it("skips default and config turn budgets for mutation agents", () => {
		const worker = agent("mi-pi-degraded-writer");
		assert.equal(shouldSkipDefaultTurnBudget(worker, "build the page"), true);
		assert.equal(
			shouldSkipConfigTurnBudget({ agent: "worker", task: "edit files" }, [agent("worker")]),
			true,
		);
		assert.equal(
			shouldSkipConfigTurnBudget(
				{ agent: "scout", task: "read-only summary" },
				[agent("scout", { acceptanceRole: "read-only", tools: ["read"] })],
			),
			false,
		);
	});

	it("annotates partial delivery when mutations were observed", () => {
		const base = "Subagent exceeded turn budget after 50 assistant turns (soft limit 44 + grace 5).";
		const msg = formatPartialDeliveryTurnBudgetMessage(base, true);
		assert.match(msg, /partial_delivery/);
		assert.match(msg, /gap-only leaf/);
		assert.equal(formatPartialDeliveryTurnBudgetMessage(base, false), base);
	});
});
