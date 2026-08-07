/**
 * Prime Agent extension — "chronobreak": terminates assistant generation loops.
 *
 * The failure: the model emits the same prose/sentence over and over inside
 * one turn, never settling on an action, and every repetition appends to the
 * session (output degradation). On detection chronobreak:
 *
 *  1. Aborts the run (ctx.abort()).
 *  2. Scrubs the polluted assistant message back to WHERE THE REPETITION
 *     BEGINS: everything before the loop (including the first occurrence of
 *     the repeated segment) is kept, the repeated garbage is dropped, and a
 *     truncation marker is appended.
 *  3. Re-injects a follow-up nudge so the model continues from that point
 *     with one decisive action. Gives up after 3 strikes per user turn.
 *
 * Detection is two-tier, recomputed from the whole accumulated message on
 * every message_update (the event carries the full partial message):
 *  - segment tier: the same normalized sentence/line appearing >= 3 times
 *    (catches prose loops; cut = start of the 2nd occurrence);
 *  - periodic tier: the streamed tail decomposing into >= 8 identical copies
 *    of a >= 20-char phrase (catches boundary-less loops; cut keeps one copy).
 *
 * Hooked at the framework event layer (message_update / message_end /
 * agent_end / input), so it observes every assistant message in every mode
 * (interactive, RPC, daemon, subagents) no matter which internal stream path
 * produced it. Shipped by prime-agent-flake via `--extension`, which stays
 * active even under `--no-extensions`. This replaces the earlier Nix build
 * patch to the agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_STRIKES = 3; // per user-turn give-up: no abort/re-run spin loop
const MAX_SEGMENT_REPEAT = 3; // same normalized segment appearing this many times in one message
const MIN_CHUNK_LEN = 12; // ignore tiny fragments (punctuation, spacing)
const LOOP_TAIL = 4096; // periodic tier: window of streamed text scanned
const LOOP_MIN_PERIOD = 20; // periodic tier: phrase length floor (chars)
const LOOP_MIN_TOTAL = 2048; // periodic tier: repeated span that must be exceeded (chars)
const SCRUB_MARKER = "[chronobreak: repeated output truncated here - re-running]";

/**
 * Normalize a text chunk: collapse whitespace, drop punctuation, lowercase.
 * Identical sentences with cosmetic differences hash to the same key.
 */
function keyOf(chunk: string): string {
	return chunk
		.replace(/\s+/g, " ")
		.replace(/[^\p{L}\p{N} ]/gu, "")
		.trim()
		.toLowerCase();
}

interface Segment {
	key: string;
	start: number; // raw offset of the chunk in the joined text
}

/** Split into sentence/line chunks, keeping each chunk's raw start offset. */
function segmentize(text: string): Segment[] {
	const segments: Segment[] = [];
	const boundary = /(?<=[.!?])\s+|\n+/g;
	let segStart = 0;
	const push = (start: number, end: number) => {
		if (end <= start) return;
		const key = keyOf(text.slice(start, end));
		if (key.length >= MIN_CHUNK_LEN) segments.push({ key, start });
	};
	for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
		push(segStart, m.index);
		segStart = boundary.lastIndex;
	}
	push(segStart, text.length);
	return segments;
}

interface LoopHit {
	sample: string;
	/** Raw offset where the repetition begins (everything before it is kept). */
	cutAt: number;
}

/**
 * Segment tier. Recomputed fresh from the full text each update: keeping
 * counts across calls would double-count earlier segments and false-trigger.
 * The cut lands on the SECOND occurrence of the repeated segment, so the
 * legitimate first occurrence survives the scrub.
 */
function detectSegmentLoop(text: string): LoopHit | null {
	const counts = new Map<string, { count: number; secondStart: number }>();
	for (const seg of segmentize(text)) {
		const entry = counts.get(seg.key) ?? { count: 0, secondStart: -1 };
		entry.count += 1;
		if (entry.count === 2) entry.secondStart = seg.start;
		counts.set(seg.key, entry);
		if (entry.count >= MAX_SEGMENT_REPEAT) {
			return { sample: seg.key, cutAt: entry.secondStart };
		}
	}
	return null;
}

/**
 * Periodic tier: does the tail of the text decompose into >= 8 identical
 * copies of a p >= LOOP_MIN_PERIOD phrase? Catches degenerate repetition that
 * never crosses a sentence/line boundary. The cut keeps one copy of the
 * phrase, dropping the rest.
 */
function detectPeriodicLoop(text: string): LoopHit | null {
	if (text.length < LOOP_MIN_TOTAL) return null;
	const win = text.slice(-LOOP_TAIL);
	for (let p = LOOP_MIN_PERIOD; p * 8 <= LOOP_TAIL && p <= 1024; p++) {
		const copies = Math.floor(LOOP_TAIL / p);
		if (copies < 8) break;
		const total = p * copies;
		if (total < LOOP_MIN_TOTAL) continue;
		if (total > win.length) continue;
		const span = win.slice(-total);
		const unit = span.slice(-p);
		let same = true;
		for (let k = 1; k < copies; k++) {
			const start = (copies - 1 - k) * p;
			if (span.slice(start, start + p) !== unit) {
				same = false;
				break;
			}
		}
		if (same) {
			return { sample: unit.trim(), cutAt: text.length - total + p };
		}
	}
	return null;
}

function detectLoop(text: string): LoopHit | null {
	return detectSegmentLoop(text) ?? detectPeriodicLoop(text);
}

function textOf(message: { content?: Array<{ type?: string; text?: string }> }): string {
	if (!message.content) return "";
	return message.content
		.filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function buildNudge(sample: string): string {
	const sampleLine = sample ? `\n\nRepeat detected: "${sample}"` : "";
	return (
		"chronobreak cut a generation loop in your previous message." +
		sampleLine +
		"\n\nEverything you wrote before the repetition began was kept; the message now ends with a " +
		"truncation marker. Continue from that point. Do NOT repeat or restate earlier output. " +
		"Take ONE decisive action in this message: a single clean tool call, or the direct final answer."
	);
}

export default function (pi: ExtensionAPI): void {
	let terminating = false;
	let pendingNudge: string | undefined;
	let strike = 0;

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		terminating = false;
	});

	pi.on("message_update", (event, ctx) => {
		if (terminating) return;
		if (event.message.role !== "assistant") return;
		const text = textOf(event.message);
		if (text.length === 0) return;
		const hit = detectLoop(text);
		if (!hit) return;

		terminating = true;
		strike++;
		if (strike >= MAX_STRIKES) {
			ctx.ui.notify(
				"chronobreak: generation loop detected, but strike limit (" + MAX_STRIKES + ") reached. Aborting without re-run.",
				"error",
			);
		} else {
			ctx.ui.notify(
				'chronobreak: generation loop detected ("' + hit.sample + '"). Truncating at the repetition and re-running.',
				"warning",
			);
			pendingNudge = buildNudge(hit.sample);
		}
		ctx.abort();
	});

	// The aborted assistant message is persisted by the runtime; scrub it back
	// to where the repetition began so the clean prefix survives and only the
	// repeated garbage is dropped from context.
	pi.on("message_end", (event) => {
		if (!terminating) return;
		if (event.message.role !== "assistant") return;
		terminating = false;
		const text = textOf(event.message);
		const hit = detectLoop(text);
		const cutAt = hit ? Math.max(0, hit.cutAt) : 0;
		const kept = text.slice(0, cutAt).trimEnd();
		const scrubbed = kept.length > 0 ? kept + "\n\n" + SCRUB_MARKER : SCRUB_MARKER;
		return {
			message: {
				...event.message,
				content: [{ type: "text" as const, text: scrubbed }],
			},
		};
	});

	pi.on("agent_end", () => {
		if (!pendingNudge) return;
		const nudge = pendingNudge;
		pendingNudge = undefined;
		pi.sendUserMessage(nudge, { deliverAs: "followUp" });
	});

	// User-driven input is a fresh direction: reset the strike counter.
	pi.on("input", (event) => {
		if (event.source === "extension") return;
		strike = 0;
	});
}
