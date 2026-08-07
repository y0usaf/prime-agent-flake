/**
 * Prime Agent extension — degenerate repeated-output loop guard ("chronobreak").
 *
 * Cheap models degrade mid-turn into verbatim sentence loops ("Let me X."
 * repeated hundreds of times), appending hundreds of KB that then get
 * persisted and re-fed as context. This extension keeps a rolling 4 KB tail
 * of the streamed assistant text, detects when it decomposes into N identical
 * copies of a periodic sentence, and aborts the request so the degenerate
 * message is cut within a few KB instead of being persisted in full.
 *
 * It is shipped by the prime-agent-flake wrapper via `--extension` so it
 * covers every session kind (interactive, RPC, daemon, subagents) and stays
 * active even under `--no-extensions` (CLI-provided extension paths are still
 * loaded). This replaces the previous Nix build patch to the agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Detects degenerate verbatim-sentence repetition ("Let me X." repeated
// thousands of times) so the loop can be aborted instead of streaming it.
// A rolling tail is kept; we periodically test whether the tail decomposes
// into N identical copies of a p>=MIN_PERIOD sentence. Returns the repeated
// phrase length observed, or 0 when no loop is present.
const LOOP_TAIL = 4096;
const LOOP_MIN_PERIOD = 20; // sentence length floor (chars)
const LOOP_MIN_TOTAL = 2048; // repeated span that must be exceeded (chars)

function detectRepetitionLoop(tail: string): number {
	if (tail.length < LOOP_MIN_TOTAL) return 0;
	const win = tail.slice(-LOOP_TAIL);
	// Try period p (sentence-ish length). For large windows the "N identical
	// copies" test is O(p); bounded by LOOP_TAIL per check.
	for (let p = LOOP_MIN_PERIOD; p * 8 <= LOOP_TAIL && p <= 1024; p++) {
		const copies = Math.floor(LOOP_TAIL / p);
		if (copies < 8) break;
		const total = p * copies;
		if (total < LOOP_MIN_TOTAL) continue;
		const unit = win.slice(-total).slice(-p);
		let same = true;
		for (let k = 1; k < copies; k++) {
			const start = (copies - 1 - k) * p;
			if (win.slice(-total).slice(start, start + p) !== unit) {
				same = false;
				break;
			}
		}
		if (same) return total;
	}
	return 0;
}

/** Joined streamed text blocks of a (partial) assistant message, if any. */
function joinedText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content) {
		if ((
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		)) {
			out.push((block as { text: string }).text);
		}
	}
	return out.join("");
}

export default function (pi: ExtensionAPI): void {
	// Per-assistant-stream state: the rolling tail of text we have seen, and
	// the length of the text in the last full-partial snapshot we consumed.
	// `message_update` carries the full partial message on every token, so the
	// incremental delta is text.slice(lastLen). This lets us mirror the agent
	// loop's per-text_delta accumulation without touching upstream code.
	let streamTail = "";
	let lastLen = 0;
	let aborting = false;

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		// A new assistant stream begins: reset per-stream accumulation.
		streamTail = "";
		lastLen = 0;
		aborting = false;
	});

	pi.on("message_update", (event, ctx) => {
		if (aborting) return;
		if (event.message.role !== "assistant") return;
		const text = joinedText(event.message.content);
		if (text.length >= lastLen) {
			streamTail = (streamTail + text.slice(lastLen)).slice(-LOOP_TAIL);
			lastLen = text.length;
		} else {
			// Content shrank (unexpected for a pure text stream): treat the
			// current snapshot as the start of a new segment.
			lastLen = text.length;
			streamTail = text.slice(-LOOP_TAIL);
		}
		if (detectRepetitionLoop(streamTail) > 0) {
			aborting = true;
			ctx.abort();
		}
	});
}
