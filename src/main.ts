import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PeriodicNotesSettingTab,
	type PeriodicNotesSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { PeriodicNoteCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import {
	emptyCache,
	type NoteExtraction,
	type PeriodicNote,
	type SynthesisCache,
} from "./types";

/** One cached extraction joined with its note's current title and date, for
 * report ordering. The extraction itself never stores the date. */
interface ReportNote {
	path: string;
	title: string;
	date: string | null;
	extraction: NoteExtraction;
}

/**
 * Shape of the single JSON blob Obsidian persists for this plugin. Settings and
 * the synthesis cache live side by side so saving one never clobbers the other.
 */
interface PersistedData {
	settings: PeriodicNotesSettings;
	cache: SynthesisCache;
}

export default class PeriodicNotesSynthesizerPlugin extends Plugin {
	settings: PeriodicNotesSettings = DEFAULT_SETTINGS;
	cache: SynthesisCache = emptyCache();

	private adapter!: LLMAdapter;
	private collector!: PeriodicNoteCollector;
	private engine!: SynthesisEngine;

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.adapter = new LLMAdapter(this.settings);
		this.collector = new PeriodicNoteCollector(this.app, this.settings);
		this.engine = new SynthesisEngine(this.adapter);

		this.addSettingTab(new PeriodicNotesSettingTab(this.app, this));

		this.addRibbonIcon("calendar-clock", "Sync daily notes", () => {
			void this.syncDailyNotes();
		});

		this.addCommand({
			id: "sync-daily-notes",
			name: "Sync daily notes",
			callback: () => {
				void this.syncDailyNotes();
			},
		});

		this.addRibbonIcon("calendar-range", "Generate periodic report", () => {
			void this.generateReport();
		});

		this.addCommand({
			id: "generate-periodic-report",
			name: "Generate periodic report",
			callback: () => {
				void this.generateReport();
			},
		});

		console.log("Periodic Notes Synthesizer loaded.");
	}

	override onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PersistedData> | null;

		// Tolerate a legacy flat-settings layout (a build that saved the settings
		// object at the top level) so an existing API key survives.
		const settingsSource =
			data && "settings" in data
				? data.settings
				: (data as Partial<PeriodicNotesSettings> | null);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource ?? {});

		this.cache =
			(data && "cache" in data ? data.cache : null) ?? emptyCache();
	}

	async saveSettings(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			cache: this.cache,
		};
		await this.saveData(data);
	}

	/**
	 * Sync daily/periodic notes: collect them, extract each new/changed one via
	 * the engine, and persist the updated cache. All vault I/O happens here — the
	 * engine never touches files. Incremental by mtime; warn-and-skip so one
	 * failing note never discards already-completed extractions.
	 */
	async syncDailyNotes(): Promise<void> {
		if (!this.settings.apiKey.trim()) {
			new Notice("Set your API key in settings first.");
			return;
		}

		const notes = await this.collector.collect();

		// Paths already cached before this run distinguish re-synthesized from new.
		const priorPaths = new Set(Object.keys(this.cache.extractions));

		let synced = 0;
		let resynthesized = 0;
		let skipped = 0;

		for (const note of notes) {
			// Incremental: an unchanged note (same mtime) costs no API call.
			const existing = this.cache.extractions[note.path];
			if (existing && existing.mtime === note.mtime) {
				continue;
			}

			try {
				const file = this.app.vault.getAbstractFileByPath(note.path);
				if (!(file instanceof TFile)) {
					skipped += 1;
					continue;
				}

				const raw = await this.app.vault.cachedRead(file);
				const stripped = this.stripFrontmatter(raw);
				const body = this.cleanBody(stripped).slice(0, MAX_INPUT_CHARS);

				const extraction = await this.engine.extractNote(note, body);
				if (!extraction) {
					skipped += 1;
					continue;
				}

				this.cache.extractions[note.path] = {
					mtime: note.mtime,
					extraction,
				};
				synced += 1;
				if (priorPaths.has(note.path)) {
					resynthesized += 1;
				}
			} catch (error) {
				// Network/read error on one note: warn and skip, keep the rest.
				console.warn(
					`[Periodic Notes Synthesizer] Sync skipped note: ${note.path}`,
					error
				);
				skipped += 1;
			}
		}

		await this.saveSettings();

		new Notice(
			`Synced ${synced} note${synced === 1 ? "" : "s"} ` +
				`(${resynthesized} re-synthesized, ${skipped} skipped).`
		);
	}

	/**
	 * Strip a leading frontmatter block (--- … ---) so the model sees only the
	 * note's prose. Pure string surgery — never touches the file.
	 */
	private stripFrontmatter(raw: string): string {
		return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	}

	/**
	 * Strip markdown noise so the truncation window lands on real prose, not
	 * navigation boilerplate: link-heavy pages otherwise fill the first 24k
	 * chars with URLs and the model sees no note text at all.
	 */
	private cleanBody(text: string): string {
		// Image embeds carry no prose — drop them entirely.
		let cleaned = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
		// Markdown links: keep the visible text, drop the URL.
		cleaned = cleaned.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
		// Bare URLs are pure token waste.
		cleaned = cleaned.replace(/https?:\/\/\S+/g, "");

		// Blank out lines left with no letters or digits (list markers,
		// brackets, punctuation), then collapse the resulting gaps so
		// paragraph structure survives but boilerplate runs don't.
		cleaned = cleaned
			.split("\n")
			.map((line) => (/[\p{L}\p{N}]/u.test(line) ? line : ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");

		return cleaned.trim();
	}

	/**
	 * Build the periodic report from the cached extractions and write it to
	 * "Periodic Synthesis.md" at the vault root, then open it. Pure cache
	 * read-out — ZERO LLM calls. Re-collects notes only to recover each cached
	 * extraction's date (the extraction itself never stores it).
	 */
	async generateReport(): Promise<void> {
		const cachedPaths = Object.keys(this.cache.extractions);
		if (cachedPaths.length === 0) {
			new Notice("No synced notes yet. Run Sync daily notes first.");
			return;
		}

		// path -> current note (for title and date). A cached extraction whose
		// path is no longer collected is still reported, just with date=null.
		const collected = await this.collector.collect();
		const byPath = new Map<string, PeriodicNote>();
		for (const note of collected) {
			byPath.set(note.path, note);
		}

		const reportNotes: ReportNote[] = [];
		for (const path of cachedPaths) {
			const entry = this.cache.extractions[path];
			const current = byPath.get(path);
			reportNotes.push({
				path,
				title: current ? current.title : this.noteName(path),
				date: current ? current.date : null,
				extraction: entry.extraction,
			});
		}

		// Date ascending, undated notes last.
		reportNotes.sort((a, b) => {
			if (a.date === null && b.date === null) {
				return 0;
			}
			if (a.date === null) {
				return 1;
			}
			if (b.date === null) {
				return -1;
			}
			return a.date.localeCompare(b.date);
		});

		const markdown = this.buildReportMarkdown(
			reportNotes,
			this.todayISO(),
			this.settings.staleDays
		);

		const path = "Periodic Synthesis.md";
		const existing = this.app.vault.getAbstractFileByPath(path);
		let file: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, markdown);
			file = existing;
		} else {
			file = await this.app.vault.create(path, markdown);
		}

		await this.app.workspace.getLeaf(false).openFile(file);
		new Notice("Periodic report generated.");
	}

	/**
	 * Render the report markdown from the prepared notes. Pure string-building:
	 * reads only the in-memory cache (for theme syntheses) and the passed notes,
	 * never the network. `todayISO` anchors the week window and stale cutoff.
	 */
	private buildReportMarkdown(
		notes: ReportNote[],
		todayISO: string,
		staleDays: number
	): string {
		const lines: string[] = [];

		lines.push("# Periodic Synthesis");
		lines.push("");
		lines.push(`_Last generated: ${todayISO}_`);
		lines.push("");

		// --- Overview (always rendered) ---
		const dated = notes.filter((n) => n.date !== null);
		let openLoopCount = 0;
		let doneCount = 0;
		let openCommitments = 0;
		for (const note of notes) {
			openLoopCount += note.extraction.openLoops.length;
			for (const commitment of note.extraction.commitments) {
				if (commitment.status === "done") {
					doneCount += 1;
				} else {
					openCommitments += 1;
				}
			}
		}

		lines.push("## Overview");
		lines.push(`- Notes synthesized: ${notes.length}`);
		if (dated.length > 0) {
			const earliest = dated[0].date;
			const latest = dated[dated.length - 1].date;
			lines.push(`- Date range: ${earliest} to ${latest}`);
		}
		lines.push(`- Open loops: ${openLoopCount}`);
		lines.push(
			`- Commitments: ${doneCount} done, ${openCommitments} open`
		);
		lines.push("");

		// --- Themes (topic shared by 2+ notes; consensus/tension only if a
		// cached themeSynthesis exists — Feature 4 populates it). ---
		const themes = this.themesOf(notes);
		if (themes.length > 0) {
			lines.push("## Themes");
			lines.push("");
			for (const theme of themes) {
				lines.push(`### ${theme.topic}`);
				const memberTitles = theme.members.map((m) => m.title).join(", ");
				lines.push(`Notes: ${memberTitles}`);
				const synthesis = this.cache.themeSyntheses[theme.topic];
				if (synthesis) {
					lines.push(synthesis.consensus);
					lines.push(`Tension: ${synthesis.tension}`);
				}
				lines.push("");
			}
		}

		// --- This week (always rendered, even when empty) ---
		const weekStart = this.weekStartOf(todayISO);
		const weekEnd = this.addDays(weekStart, 7);
		const thisWeek = notes.filter(
			(n) => n.date !== null && n.date >= weekStart && n.date < weekEnd
		);
		lines.push("## This week");
		if (thisWeek.length === 0) {
			lines.push("_No notes this week._");
		} else {
			for (const note of thisWeek) {
				lines.push(
					`- **${note.title}** (${note.date}): ${this.oneLine(note.extraction.summary)}`
				);
			}
		}
		lines.push("");

		// --- Open loops (oldest note first; nulls already last) ---
		const today = todayISO.slice(0, 10);
		const openLoopLines: string[] = [];
		for (const note of notes) {
			for (const loop of note.extraction.openLoops) {
				const dateLabel = note.date ?? "no date";
				let line = `- ${loop} — _${note.title}, ${dateLabel}_`;
				if (note.date !== null && this.daysBetween(note.date, today) > staleDays) {
					line += " **(stale)**";
				}
				openLoopLines.push(line);
			}
		}
		if (openLoopLines.length > 0) {
			lines.push("## Open loops");
			for (const line of openLoopLines) {
				lines.push(line);
			}
			lines.push("");
		}

		// --- Said vs did (groups by existing commitment status; no matching) ---
		const doneLines: string[] = [];
		const openLines: string[] = [];
		for (const note of notes) {
			for (const commitment of note.extraction.commitments) {
				const line = `- ${commitment.text} — _${note.title}_`;
				if (commitment.status === "done") {
					doneLines.push(line);
				} else {
					openLines.push(line);
				}
			}
		}
		if (doneLines.length > 0 || openLines.length > 0) {
			lines.push("## Said vs did");
			if (doneLines.length > 0) {
				lines.push("### Done");
				for (const line of doneLines) {
					lines.push(line);
				}
				lines.push("");
			}
			if (openLines.length > 0) {
				lines.push("### Still open");
				for (const line of openLines) {
					lines.push(line);
				}
				lines.push("");
			}
		}

		// --- Summaries (date order) ---
		lines.push("## Summaries");
		for (const note of notes) {
			const dateLabel = note.date ?? "no date";
			lines.push(`### ${note.title} (${dateLabel})`);
			lines.push(note.extraction.summary);
			if (note.extraction.topics.length > 0) {
				lines.push("");
				lines.push(`_Topics: ${note.extraction.topics.join(", ")}_`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Group notes into themes by shared lowercase topic. Only a topic carried by
	 * 2+ distinct notes is a theme. Biggest theme first, then alphabetically —
	 * deterministic. The topic string is the theme key, matching the convention
	 * Feature 4's theme synthesis will use.
	 */
	private themesOf(
		notes: ReportNote[]
	): Array<{ topic: string; members: ReportNote[] }> {
		const groups = new Map<string, ReportNote[]>();
		for (const note of notes) {
			for (const topic of new Set(note.extraction.topics)) {
				const members = groups.get(topic) ?? [];
				members.push(note);
				groups.set(topic, members);
			}
		}
		return [...groups.entries()]
			.filter(([, members]) => members.length >= 2)
			.sort(
				([topicA, a], [topicB, b]) =>
					b.length - a.length || topicA.localeCompare(topicB)
			)
			.map(([topic, members]) => ({ topic, members }));
	}

	/** Vault path → note name (drop folders and .md). */
	private noteName(sourcePath: string): string {
		const base = sourcePath.split("/").pop() ?? sourcePath;
		return base.replace(/\.md$/i, "");
	}

	/** Flatten multiline text to a single line for list items. */
	private oneLine(text: string): string {
		return text.replace(/\s*\n\s*/g, " ").trim();
	}

	/**
	 * Monday of the week containing `todayISO`, as YYYY-MM-DD. Sunday belongs to
	 * the previous Monday (steps back 6 days). Day-of-week is read via UTC on the
	 * fixed calendar-date components, and the window check compares YYYY-MM-DD
	 * strings lexicographically — so no timezone parsing can shift the boundary.
	 */
	private weekStartOf(todayISO: string): string {
		const day = todayISO.slice(0, 10);
		const [year, month, date] = day.split("-").map(Number);
		const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
		const daysSinceMonday = dow === 0 ? 6 : dow - 1;
		return this.addDays(day, -daysSinceMonday);
	}

	/**
	 * Add days to a YYYY-MM-DD calendar date, returning YYYY-MM-DD. Arithmetic
	 * runs in UTC so month boundaries and DST never shift the result.
	 */
	private addDays(dateOnly: string, days: number): string {
		const [year, month, day] = dateOnly.split("-").map(Number);
		const dt = new Date(Date.UTC(year, month - 1, day));
		dt.setUTCDate(dt.getUTCDate() + days);
		const y = dt.getUTCFullYear();
		const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
		const d = String(dt.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}

	/**
	 * Whole days from one YYYY-MM-DD calendar date to another (to − from). UTC
	 * millisecond difference, same Date-math approach as {@link addDays}, so
	 * timezone and DST never shift the count.
	 */
	private daysBetween(fromDay: string, toDay: string): number {
		const [fy, fm, fd] = fromDay.split("-").map(Number);
		const [ty, tm, td] = toDay.split("-").map(Number);
		const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
		return Math.round(ms / 86400000);
	}

	/**
	 * Today as a calendar-date string (YYYY-MM-DD) in LOCAL time — never
	 * toISOString(), which would shift the date across the UTC boundary in
	 * non-UTC timezones. This is the single place "today" enters the system.
	 */
	private todayISO(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
}
