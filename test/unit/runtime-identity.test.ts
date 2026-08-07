import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RUNTIME_IDENTITY_HEADER,
	buildRuntimeIdentityBlock,
	injectRuntimeIdentitySystemPrompt,
	stripRuntimeIdentityBlock,
} from "../../src/runs/shared/runtime-identity.ts";

describe("runtime identity", () => {
	it("builds an authoritative role/model/thinking block", () => {
		const block = buildRuntimeIdentityBlock({
			role: "scout",
			model: "nan/qwen3.6:max",
			thinking: "max",
		});
		assert.ok(block.includes(RUNTIME_IDENTITY_HEADER));
		assert.match(block, /- role: scout/);
		assert.match(block, /- model: nan\/qwen3\.6:max/);
		assert.match(block, /- thinking: max/);
		assert.match(block, /Do not invent a different model id/);
	});

	it("injects and replaces identity without duplicating", () => {
		const first = injectRuntimeIdentitySystemPrompt("You are a scout.", {
			role: "scout",
			model: "nan/qwen3.6:max",
			thinking: "max",
		});
		const second = injectRuntimeIdentitySystemPrompt(first, {
			role: "scout",
			model: "openai-codex/gpt-5.6-luna:low",
			thinking: "low",
		});
		assert.equal(second.indexOf(RUNTIME_IDENTITY_HEADER), second.lastIndexOf(RUNTIME_IDENTITY_HEADER));
		assert.match(second, /openai-codex\/gpt-5\.6-luna:low/);
		assert.doesNotMatch(second, /nan\/qwen3\.6:max/);
		assert.ok(second.startsWith("You are a scout."));
	});

	it("strips identity blocks cleanly", () => {
		const withIdentity = injectRuntimeIdentitySystemPrompt("Base prompt", {
			role: "worker",
			model: "xai/grok-4.5:low",
		});
		assert.equal(stripRuntimeIdentityBlock(withIdentity).trim(), "Base prompt");
	});

	it("no-ops when identity fields are empty", () => {
		assert.equal(injectRuntimeIdentitySystemPrompt("keep", {}), "keep");
	});
});
