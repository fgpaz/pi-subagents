/**
 * Authoritative runtime identity for child subagents.
 * Injected at launch (and reinforced in the child before_agent_start hook)
 * so leaves do not invent model ids from inherited parent/CoS prose.
 */

export const RUNTIME_IDENTITY_HEADER = "## Runtime identity (authoritative)";

const RUNTIME_IDENTITY_BLOCK_RE =
	/(?:\r?\n){0,2}## Runtime identity \(authoritative\)\r?\n[\s\S]*?(?=(?:\r?\n){2}## |\r?\n*$)/;

export interface RuntimeIdentityInput {
	role?: string;
	/** Canonical provider/id, optionally with :thinking suffix. */
	model?: string;
	thinking?: string;
}

export function buildRuntimeIdentityBlock(input: RuntimeIdentityInput): string {
	const lines = [RUNTIME_IDENTITY_HEADER];
	const role = input.role?.trim();
	const model = input.model?.trim();
	const thinking = input.thinking?.trim();
	if (role) lines.push(`- role: ${role}`);
	if (model) lines.push(`- model: ${model}`);
	if (thinking) lines.push(`- thinking: ${thinking}`);
	lines.push("Prefer this block over any inherited parent text about models or providers.");
	lines.push("Do not invent a different model id. If asked which model you are, quote this block exactly.");
	return lines.join("\n");
}

export function stripRuntimeIdentityBlock(prompt: string): string {
	if (!prompt.includes(RUNTIME_IDENTITY_HEADER)) return prompt;
	return prompt.replace(RUNTIME_IDENTITY_BLOCK_RE, "").replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

export function injectRuntimeIdentitySystemPrompt(
	systemPrompt: string,
	input: RuntimeIdentityInput,
): string {
	const role = input.role?.trim();
	const model = input.model?.trim();
	const thinking = input.thinking?.trim();
	if (!role && !model && !thinking) return systemPrompt;
	const block = buildRuntimeIdentityBlock({ role, model, thinking });
	const base = stripRuntimeIdentityBlock(systemPrompt ?? "").trim();
	return base ? `${base}\n\n${block}` : block;
}
