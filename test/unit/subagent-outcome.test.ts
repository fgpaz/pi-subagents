import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectSubagentError } from "../../src/shared/utils.ts";

describe("subagent outcome detection", () => {
	it("retains terminal provider errors after a successful tool call", () => {
		const outcome = detectSubagentError([
			{ role: "assistant", stopReason: "error", errorMessage: "provider disconnected" },
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "recovered tool call" }] },
		] as never);
		assert.equal(outcome.hasError, true);
		assert.equal(outcome.errorType, "provider");
		assert.equal(outcome.details, "provider disconnected");
	});

	it("clears a recovered tool error after a later successful tool call", () => {
		const outcome = detectSubagentError([
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "bash failed (exit 1): transient" }] },
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "success" }] },
		] as never);
		assert.deepEqual(outcome, { hasError: false });
	});

	it("reports the latest unrecovered tool error", () => {
		const outcome = detectSubagentError([
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] },
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "exit code 7" }] },
		] as never);
		assert.equal(outcome.hasError, true);
		assert.equal(outcome.exitCode, 7);
		assert.equal(outcome.errorType, "bash");
	});
});
