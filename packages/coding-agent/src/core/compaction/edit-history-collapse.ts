/**
 * Superseded edit collapse — deterministic, model-free, context-only.
 *
 * Repeated successful `edit` calls to the same file are collapsed in the
 * outgoing provider context: every edit in a closed group except the last
 * becomes a tiny stub. The last edit of a group and every edit in the most
 * recent (still open) group stay verbatim.
 *
 * Design constraints:
 * - No LLM summarisation. Pure string/object surgery over `arguments`.
 * - Never mutate the persisted session. Callers pass the outgoing message
 *   array; this function returns a copy-on-write projection.
 * - Never delete or reorder toolCall/toolResult messages. Every id, name,
 *   thinking block, and message stays in place; only the toolCall arguments
 *   and the paired toolResult text are rewritten.
 * - Failed edits (`isError: true`) and their toolCalls are skipped entirely.
 * - Only closed groups are rewritten. A group is closed when a later group
 *   exists, so the active file is never collapsed. Rewrites are monotonic:
 *   history bytes change once per group closure, preserving prompt-cache hits.
 * - Idempotent: collapsed calls are ignored, and the input array reference is
 *   returned when there is nothing to do.
 *
 * Path canonicalisation uses `resolveToCwd` only (no filesystem access), so
 * two spellings of the same path group together. Symlink aliases are not
 * resolved; a symlinked path and its target are treated as different files.
 */
import type { AgentMessage } from "@bramburn/qi-agent-core";
import type { TextContent } from "@bramburn/qi-ai";
import { resolveToCwd } from "../tools/path-utils.ts";

export const COLLAPSED_EDIT_NOTE =
	"Superseded edit collapsed (deepseekHarness.collapseSupersededEdits). A later edit to this file is kept in history; use read for the current file content.";

export interface EditCollapseOptions {
	/** Collapse a closed group only when its combined serialized edit payload exceeds this many characters. */
	thresholdChars: number;
}

export const DEFAULT_EDIT_COLLAPSE_THRESHOLD_CHARS = 8192;

interface EditCallSite {
	messageIndex: number;
	toolCallId: string;
	displayPath: string;
	path: string;
	payloadChars: number;
}

function readEditPath(args: Record<string, unknown>): string | undefined {
	// Already collapsed — keeps the transform idempotent.
	if (args.collapsed === true) return undefined;
	const raw =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Rewrite superseded edit calls in `messages`. Returns a new array when a
 * rewrite is needed, otherwise the original array reference.
 */
export function collapseSupersededEdits(
	messages: AgentMessage[],
	cwd: string,
	options: EditCollapseOptions,
): AgentMessage[] {
	// Pass 1: index successful edit results and user-message positions.
	const resultIndexByCallId = new Map<string, number>();
	const userPrefix: number[] = new Array(messages.length + 1).fill(0);
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		userPrefix[i + 1] = userPrefix[i] + (message.role === "user" ? 1 : 0);
		if (message.role === "toolResult" && message.toolName === "edit" && !message.isError) {
			resultIndexByCallId.set(message.toolCallId, i);
		}
	}

	// Pass 2: collect edit call sites in history order (assistant toolCall blocks).
	const sites: EditCallSite[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "edit") continue;
			if (!resultIndexByCallId.has(block.id)) continue;
			const args = block.arguments as Record<string, unknown>;
			const displayPath = readEditPath(args);
			if (!displayPath) continue;
			sites.push({
				messageIndex: i,
				toolCallId: block.id,
				displayPath,
				path: resolveToCwd(displayPath, cwd),
				payloadChars: JSON.stringify(args).length,
			});
		}
	}

	// Pass 3: group consecutive same-path sites; a user message between sites
	// also breaks a group.
	const groups: EditCallSite[][] = [];
	for (const site of sites) {
		const current = groups[groups.length - 1];
		const previous = current?.[current.length - 1];
		const userBetween =
			previous !== undefined && userPrefix[site.messageIndex] - userPrefix[previous.messageIndex + 1] > 0;
		if (!current || !previous || previous.path !== site.path || userBetween) {
			groups.push([site]);
		} else {
			current.push(site);
		}
	}

	// Pass 4: select rewrites — every closed group (all but the last) with at
	// least two calls and a combined payload over the threshold.
	const rewriteIds = new Set<string>();
	for (let g = 0; g < groups.length - 1; g++) {
		const group = groups[g];
		if (group.length < 2) continue;
		const total = group.reduce((sum, site) => sum + site.payloadChars, 0);
		if (total <= options.thresholdChars) continue;
		for (const site of group.slice(0, -1)) rewriteIds.add(site.toolCallId);
	}
	if (rewriteIds.size === 0) return messages;

	// Pass 5: copy-on-write rewrite. Never remove messages or blocks and never
	// touch thinking blocks.
	const pathByCallId = new Map(sites.map((site) => [site.toolCallId, site.displayPath]));
	const collapsedContent: TextContent[] = [{ type: "text", text: COLLAPSED_EDIT_NOTE }];
	return messages.map((message): AgentMessage => {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "toolCall" || !rewriteIds.has(block.id)) return block;
				changed = true;
				return {
					...block,
					arguments: {
						path: pathByCallId.get(block.id),
						collapsed: true,
						note: COLLAPSED_EDIT_NOTE,
					},
				};
			});
			return changed ? { ...message, content } : message;
		}
		if (message.role === "toolResult" && rewriteIds.has(message.toolCallId)) {
			return { ...message, content: collapsedContent };
		}
		return message;
	});
}
