import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { applyWriterBudgetPolicy, agentLooksMutationCapable, shouldSkipDefaultTurnBudget } from "../../src/runs/shared/writer-budget-policy.ts";

function agent(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: `${name}.md`,
		...extra,
	};
}

describe("writer budget policy", () => {
	it("recognizes mutation-capable workers and skips their default turn cap", () => {
		const worker = agent("worker");
		assert.equal(agentLooksMutationCapable({ agentName: worker.name, task: "Implement the parser fix" }), true);
		assert.equal(shouldSkipDefaultTurnBudget(worker, "Implement the parser fix"), true);
	});

	it("strips hard budgets for writer launches while preserving unrelated controls", () => {
		const writer = agent("writer");
		const timeout = 120_000;
		const input = { agent: "writer", task: "Fix the bug", turnBudget: { maxTurns: 4 }, toolBudget: { hard: 8, soft: 5 }, timeoutMs: timeout };
		const result = applyWriterBudgetPolicy(input, [writer]);
		assert.equal(result.params.turnBudget, undefined);
		assert.equal(result.params.toolBudget, undefined);
		assert.equal(result.params.timeoutMs, timeout);
		assert.deepEqual(result.stripped.map((event) => event.field), ["turnBudget", "toolBudget"]);
	});

	it("keeps count budgets for explicitly read-only agents", () => {
		const scout = agent("scout", { acceptanceRole: "read-only", tools: ["read", "search"] });
		const input = { agent: "scout", task: "Inspect the implementation and report findings", turnBudget: { maxTurns: 4 }, toolBudget: { hard: 8 } };
		const result = applyWriterBudgetPolicy(input, [scout]);
		assert.equal(result.params.turnBudget, input.turnBudget);
		assert.equal(result.params.toolBudget, input.toolBudget);
		assert.deepEqual(result.stripped, []);
	});
});
