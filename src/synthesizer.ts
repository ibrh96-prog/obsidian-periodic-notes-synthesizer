import type { LLMAdapter } from "./llm";
import { djb2 } from "./types";
import type { Commitment, NoteExtraction, PeriodicNote } from "./types";

// --- Shape the LLM is asked to return (validated before use) ---

interface RawNoteExtraction {
	summary: string;
	topics: string[];
	commitments: string[];
	openLoops: string[];
	language?: string;
}

/**
 * Why a parse attempt yielded nothing usable. "invalid-json" and "empty"
 * (syntactically valid JSON but no real value in it) have different causes in
 * the field — weak JSON mode vs. a note the model couldn't read — so they are
 * reported separately.
 */
type ParseOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "invalid-json" }
	| { kind: "empty" };

const EXTRACTION_SYSTEM_PROMPT = [
	"You extract structured data from a single daily/periodic note.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "summary": string,',
	'  "topics": string[],',
	'  "commitments": string[],',
	'  "openLoops": string[],',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- "summary" is 2-3 sentences giving a high-level overview of what the',
	"  note is about, written in the note's OWN language.",
	'- "topics" are broad canonical category labels, lowercase, no duplicates.',
	"  Use BROAD, reusable categories that other notes would also share,",
	"  NOT specific names, products, or events.",
	'- "commitments" are intentions, plans, or tasks the author stated they',
	"  WILL do, in the author's own words, each one short. If the note states",
	"  none, use an empty array.",
	'- "openLoops" are unresolved questions or pending items raised that day.',
	"  If the note has none, use an empty array.",
	'- "language" is the ISO 639-1 code of the note\'s language,',
	'  e.g. "en", "tr", "de".',
	'- If a field is unknown, use an empty array or "" as appropriate.',
	"- Do NOT invent content that is not in the note.",
].join("\n");

const MATCH_SYSTEM_PROMPT = [
	"You decide which stated commitments were later completed, based ONLY on",
	"summaries of notes written AFTER each commitment.",
	"",
	"A commitment counts as done only if a later summary clearly indicates it",
	"was completed, resolved, or finished. When unsure, leave it open.",
	"",
	"Respond with ONLY a JSON object — no markdown code fences, no commentary,",
	"no prose before or after — of exactly this shape:",
	'{ "done": ["id1", "id2", ...] }',
	"containing the ids of the completed commitments. Use an empty array when",
	"none were completed.",
].join("\n");

const THEME_SYSTEM_PROMPT = [
	"You analyze how a set of daily/periodic notes relate around a shared theme.",
	"",
	"Identify the CONSENSUS — the throughline, what consistently holds across",
	"the notes — and the TENSION — any contradiction, unresolved conflict, or",
	"shift over time.",
	"",
	"Respond with ONLY a JSON object — no markdown code fences, no commentary,",
	"no prose before or after — of exactly this shape:",
	"{",
	'  "consensus": string,',
	'  "tension": string,',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- Write "consensus" and "tension" in the dominant language of the notes.',
	'- If there is no real tension, set "tension" to "" — do NOT invent one.',
	'- "language" is the ISO 639-1 code of that dominant language,',
	'  e.g. "en", "tr", "de".',
].join("\n");

/**
 * Pure synthesis engine. No Obsidian API, no clock, no vault I/O — the only
 * outside contact is the network, through the injected {@link LLMAdapter}.
 * Phase 3 Feature 1: per-note extraction.
 */
export class SynthesisEngine {
	private readonly adapter: LLMAdapter;

	constructor(adapter: LLMAdapter) {
		this.adapter = adapter;
	}

	/**
	 * Decide which stated commitments were later completed, using only summaries
	 * of notes written after each commitment. One LLM call per sync. Returns the
	 * ids judged "done" (filtered to ids actually present in the input). Empty
	 * input short-circuits with no LLM call. Pure: the caller maps ids back to
	 * commitments and writes statuses; the engine never touches the cache.
	 *
	 * Throws on a second parse failure so the caller can warn-and-skip (leaving
	 * every commitment open). Never crashes the sync — the caller wraps this.
	 */
	async matchCommitments(input: {
		commitments: { id: string; text: string; date: string | null }[];
		laterSummaries: { date: string | null; summary: string }[];
	}): Promise<string[]> {
		if (input.commitments.length === 0) {
			return [];
		}

		const userPrompt = this.buildMatchPrompt(input);

		const first = await this.adapter.complete(MATCH_SYSTEM_PROMPT, userPrompt);
		let done = this.parseMatch(first);
		if (done === null) {
			const retryPrompt =
				`${userPrompt}\n\n` +
				"Your previous output was not valid JSON. Return ONLY the JSON " +
				'object {"done": [...]}.';
			const second = await this.adapter.complete(
				MATCH_SYSTEM_PROMPT,
				retryPrompt
			);
			done = this.parseMatch(second);
			if (done === null) {
				throw new Error("Commitment matching returned unparseable JSON twice.");
			}
		}

		// Drop any id the model invented that isn't a real commitment.
		const validIds = new Set(input.commitments.map((c) => c.id));
		return done.filter((id) => validIds.has(id));
	}

	private buildMatchPrompt(input: {
		commitments: { id: string; text: string; date: string | null }[];
		laterSummaries: { date: string | null; summary: string }[];
	}): string {
		const commitments = input.commitments.map((c) => ({
			id: c.id,
			text: c.text,
			date: c.date,
		}));
		const laterSummaries = input.laterSummaries.map((s) => ({
			date: s.date,
			summary: s.summary,
		}));
		return [
			"Commitments (each with its id, text, and the date it was made):",
			JSON.stringify(commitments, null, 2),
			"",
			"Note summaries (each with its date):",
			JSON.stringify(laterSummaries, null, 2),
			"",
			"For each commitment, look ONLY at summaries dated AFTER the",
			"commitment's own date. A commitment is done only if such a later",
			"summary clearly indicates it was completed, resolved, or finished.",
			'Return ONLY {"done": [ids]} listing the ids of completed commitments.',
		].join("\n");
	}

	/**
	 * Safe-parse the matching response into an id list. Returns null on invalid
	 * JSON (caller retries once, then throws). A valid object whose "done" is
	 * missing or malformed yields [] — that's a legitimate "nothing completed".
	 */
	private parseMatch(raw: string): string[] | null {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return null;
		}
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;
		return this.toStringArray(obj["done"]);
	}

	/**
	 * Synthesize one theme from its member notes' summaries. One LLM call.
	 * Returns the consensus/tension (and optional language); the caller stamps
	 * the signature and stores it. Safe-parse with one retry, then throws on a
	 * second failure so the caller can warn-and-skip this theme. Pure: never
	 * touches the cache.
	 */
	async synthesizeTheme(input: {
		topic: string;
		members: { summary: string; date: string | null }[];
	}): Promise<{ consensus: string; tension: string; language?: string }> {
		const userPrompt = this.buildThemePrompt(input);

		const first = await this.adapter.complete(THEME_SYSTEM_PROMPT, userPrompt);
		let synthesis = this.parseTheme(first);
		if (synthesis === null) {
			const retryPrompt =
				`${userPrompt}\n\n` +
				"Your previous output was not valid JSON. Return ONLY the JSON object.";
			const second = await this.adapter.complete(
				THEME_SYSTEM_PROMPT,
				retryPrompt
			);
			synthesis = this.parseTheme(second);
			if (synthesis === null) {
				throw new Error("Theme synthesis returned unparseable JSON twice.");
			}
		}

		return synthesis;
	}

	private buildThemePrompt(input: {
		topic: string;
		members: { summary: string; date: string | null }[];
	}): string {
		const lines = [`Theme: ${input.topic}`, "", "Notes:"];
		for (const member of input.members) {
			lines.push("");
			lines.push(`Date: ${member.date ?? "no date"}`);
			lines.push(`Summary: ${this.oneLine(member.summary)}`);
		}
		return lines.join("\n");
	}

	/**
	 * Safe-parse a theme synthesis response. Returns null on invalid JSON (caller
	 * retries once, then throws). Coerces a missing consensus/tension to "".
	 */
	private parseTheme(
		raw: string
	): { consensus: string; tension: string; language?: string } | null {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return null;
		}
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const synthesis: { consensus: string; tension: string; language?: string } =
			{
				consensus:
					typeof obj["consensus"] === "string" ? obj["consensus"].trim() : "",
				tension:
					typeof obj["tension"] === "string" ? obj["tension"].trim() : "",
			};

		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			synthesis.language = languageMatch[0];
		}

		return synthesis;
	}

	/** Flatten multiline text to a single line for prompt list items. */
	private oneLine(text: string): string {
		return text.replace(/\s*\n\s*/g, " ").trim();
	}

	/**
	 * Ask the LLM to extract one note. Parses the response defensively and
	 * retries once on invalid JSON. Returns null (and warns) if both attempts
	 * fail, if the request itself throws (network/auth), or if the result is
	 * valid-but-empty (no summary and no topics — boilerplate/nav noise) — so
	 * the caller can warn-and-skip without aborting the whole sync.
	 */
	async extractNote(
		note: PeriodicNote,
		body: string
	): Promise<NoteExtraction | null> {
		const userPrompt = this.buildUserPrompt(note, body);

		try {
			const first = await this.adapter.complete(
				EXTRACTION_SYSTEM_PROMPT,
				userPrompt
			);
			const firstOutcome = this.parseExtraction(first);
			if (firstOutcome.kind === "ok") {
				return this.toNoteExtraction(note, firstOutcome.value);
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but contained no summary. " +
						"Return the JSON object with a non-empty summary."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.adapter.complete(
				EXTRACTION_SYSTEM_PROMPT,
				retryPrompt
			);
			const secondOutcome = this.parseExtraction(second);
			if (secondOutcome.kind === "ok") {
				return this.toNoteExtraction(note, secondOutcome.value);
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but empty extraction"
					: "invalid JSON";
			console.warn(
				`[Periodic Notes Synthesizer] Extraction failed (${reason}) for note: ${note.path}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Periodic Notes Synthesizer] Extraction request failed for note: ${note.path}`,
				error
			);
			return null;
		}
	}

	private buildUserPrompt(note: PeriodicNote, body: string): string {
		const lines = [`Title: ${note.title}`];
		if (note.date) {
			lines.push(`Date: ${note.date}`);
		}
		lines.push("", "Note content:", body);
		return lines.join("\n");
	}

	/** Assemble the cached extraction from a validated LLM result. */
	private toNoteExtraction(
		note: PeriodicNote,
		raw: RawNoteExtraction
	): NoteExtraction {
		const commitments: Commitment[] = raw.commitments.map((text) => ({
			text,
			status: "open",
		}));

		const extraction: NoteExtraction = {
			id: djb2(note.path),
			summary: raw.summary,
			topics: raw.topics,
			commitments,
			openLoops: raw.openLoops,
		};
		if (raw.language !== undefined) {
			extraction.language = raw.language;
		}
		return extraction;
	}

	private parseExtraction(raw: string): ParseOutcome<RawNoteExtraction> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		const extraction = this.coerceExtraction(value);
		if (extraction === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", value: extraction };
	}

	/**
	 * Best-effort JSON recovery from a raw model response. Strips code fences,
	 * parses as-is, and if that fails retries on the substring from the first
	 * "{" to the last "}" (weak models often wrap JSON in prose). Returns
	 * undefined when nothing parses — a safe sentinel, since JSON.parse never
	 * yields it.
	 */
	private extractJsonValue(raw: string): unknown {
		const cleaned = this.stripFences(raw);

		const direct = this.tryParseJson(cleaned);
		if (direct !== undefined) {
			return direct;
		}

		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start !== -1 && end > start) {
			return this.tryParseJson(cleaned.slice(start, end + 1));
		}
		return undefined;
	}

	/** JSON.parse that returns undefined instead of throwing. */
	private tryParseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Remove an accidental ```json … ``` wrapper before parsing. */
	private stripFences(raw: string): string {
		let text = raw.trim();
		if (text.startsWith("```")) {
			text = text
				.replace(/^```[a-zA-Z]*\s*/, "")
				.replace(/\s*```$/, "");
		}
		return text.trim();
	}

	/**
	 * Validate/normalize an arbitrary parsed value into a RawNoteExtraction.
	 * Valid-but-empty (no summary AND no topics) returns null so the caller
	 * warn-and-skips boilerplate/nav notes.
	 */
	private coerceExtraction(value: unknown): RawNoteExtraction | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const summary =
			typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
		const topics = this.dedupe(
			this.toStringArray(obj["topics"]).map((t) => t.toLowerCase())
		);

		if (summary === "" && topics.length === 0) {
			return null;
		}

		const extraction: RawNoteExtraction = {
			summary,
			topics,
			commitments: this.toStringArray(obj["commitments"]),
			openLoops: this.toStringArray(obj["openLoops"]),
		};

		// Accept "en" but also sloppy variants like "en-US"; keep the 639-1 part.
		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			extraction.language = languageMatch[0];
		}

		return extraction;
	}

	private toStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter((v) => v !== "");
	}

	private dedupe(values: string[]): string[] {
		return [...new Set(values)];
	}
}
