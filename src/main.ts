import { Modal, Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PeriodicNotesSettingTab,
	type PeriodicNotesSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { PeriodicNoteCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import { verifyLicense, GUMROAD_URL } from "./license";
import {
	djb2,
	emptyCache,
	type NoteExtraction,
	type PeriodicNote,
	type SynthesisCache,
	type ThemeSynthesis,
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
	private isSyncInProgress = false;

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

		// Concurrency guard: one sync at a time.
		if (this.isSyncInProgress) {
			new Notice("A sync is already running.");
			return;
		}

		// Pro gate. Lifetime free tier: 3 successful syncs total, no monthly reset.
		// Pro users are never counted or blocked. Bail before any LLM call.
		const isPro = verifyLicense(this.settings.proLicenseKey).valid;
		if (!isPro && this.settings.freeUsage.count >= 3) {
			new ProUpgradeModal(this.app).open();
			return;
		}

		// Reserve the free-tier slot now, before any await, then refund on failure.
		// This prevents a double-tap from consuming two slots concurrently.
		this.isSyncInProgress = true;
		if (!isPro) {
			this.settings.freeUsage.count += 1;
			await this.saveSettings();
		}

		try {
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

			// --- Theme synthesis: synthesize each shared-topic theme (incremental).
			// Runs after extraction, before said-vs-did matching.
			const synthesizedThemes = await this.synthesizeThemes(notes);

			// --- Said vs did: recompute commitment completion across the FULL cached
			// set every sync. A commitment from an earlier note can be completed by a
			// note synced in a later run, so this runs whenever any extraction exists
			// — even an incremental sync that synced 0 new notes. Idempotent: reset
			// every commitment to "open", then mark the ones the model judged done.
			const markedDone = await this.matchCommitments(notes);

			await this.saveSettings();

			const themesClause =
				synthesizedThemes > 0
					? ` ${synthesizedThemes} theme${synthesizedThemes === 1 ? "" : "s"} synthesized.`
					: "";
			const doneClause =
				markedDone > 0
					? ` ${markedDone} commitment${markedDone === 1 ? "" : "s"} marked done.`
					: "";
			new Notice(
				`Synced ${synced} note${synced === 1 ? "" : "s"} ` +
					`(${resynthesized} re-synthesized, ${skipped} skipped).${themesClause}${doneClause}`
			);
		} catch (error) {
			// Refund the reserved free-tier slot so a failed sync doesn't waste a use.
			if (!isPro) {
				this.settings.freeUsage.count -= 1;
				await this.saveSettings();
			}
			throw error;
		} finally {
			this.isSyncInProgress = false;
		}
	}

	/**
	 * Synthesize each theme (a lowercase topic shared by 2+ cached notes) via one
	 * LLM call, incrementally. A theme is re-synthesized only when its member set
	 * or any member's mtime changed (signature mismatch) — unchanged themes cost
	 * zero tokens. A failed theme is warned and skipped, leaving any prior entry
	 * untouched. Syntheses for topics that are no longer themes are pruned.
	 * Returns the count actually synthesized this run (for the Notice).
	 */
	private async synthesizeThemes(notes: PeriodicNote[]): Promise<number> {
		const cachedPaths = Object.keys(this.cache.extractions);

		const dateByPath = new Map<string, string | null>();
		for (const note of notes) {
			dateByPath.set(note.path, note.date);
		}

		// Group cached note paths by lowercase topic.
		const groups = new Map<string, string[]>();
		for (const path of cachedPaths) {
			const extraction = this.cache.extractions[path].extraction;
			for (const topic of new Set(extraction.topics)) {
				const members = groups.get(topic) ?? [];
				members.push(path);
				groups.set(topic, members);
			}
		}

		// Themes = topics carried by 2+ distinct notes.
		const themeKeys = new Set<string>();
		for (const [topic, paths] of groups) {
			if (paths.length >= 2) {
				themeKeys.add(topic);
			}
		}

		let synthesized = 0;
		for (const topic of themeKeys) {
			const memberPaths = groups.get(topic) ?? [];
			const signature = this.themeSignature(memberPaths);

			const existing = this.cache.themeSyntheses[topic];
			if (existing && existing.signature === signature) {
				// Members and their mtimes unchanged — reuse, no API call.
				continue;
			}

			const members = memberPaths.map((path) => ({
				summary: this.cache.extractions[path].extraction.summary,
				date: dateByPath.get(path) ?? null,
			}));

			try {
				const result = await this.engine.synthesizeTheme({ topic, members });
				const entry: ThemeSynthesis = {
					consensus: result.consensus,
					tension: result.tension,
					signature,
				};
				if (result.language !== undefined) {
					entry.language = result.language;
				}
				this.cache.themeSyntheses[topic] = entry;
				synthesized += 1;
			} catch (error) {
				// One bad theme never aborts the sync; leave any prior entry as-is.
				console.warn(
					`[Periodic Notes Synthesizer] Theme synthesis failed for theme: ${topic}`,
					error
				);
			}
		}

		// Prune syntheses for topics that are no longer 2+-member themes.
		for (const key of Object.keys(this.cache.themeSyntheses)) {
			if (!themeKeys.has(key)) {
				delete this.cache.themeSyntheses[key];
			}
		}

		return synthesized;
	}

	/**
	 * Change-detection signature for a theme: a djb2 hash of its member
	 * "path:mtime" pairs, sorted so order never affects it. Identical signature
	 * ⇒ same members, none edited ⇒ no need to re-synthesize.
	 */
	private themeSignature(memberPaths: string[]): string {
		const parts = memberPaths
			.map((path) => `${path}:${this.cache.extractions[path].mtime}`)
			.sort();
		return djb2(parts.join("|"));
	}

	/**
	 * Recompute said-vs-did across the whole cache via one LLM call. Resets every
	 * cached commitment to "open" first (idempotent recompute), then marks those
	 * the model judged completed as "done". Commitment ids are derived on the fly
	 * from path + text — never persisted, only used to map the model's answer
	 * back. Never crashes the sync: any failure warns and leaves all commitments
	 * open. Returns the count marked done (0 on failure or when none completed).
	 */
	private async matchCommitments(notes: PeriodicNote[]): Promise<number> {
		const cachedPaths = Object.keys(this.cache.extractions);
		if (cachedPaths.length === 0) {
			return 0;
		}

		// path -> current date (undated or vanished notes resolve to null).
		const dateByPath = new Map<string, string | null>();
		for (const note of notes) {
			dateByPath.set(note.path, note.date);
		}

		// RESET: every commitment back to open before re-deciding.
		for (const path of cachedPaths) {
			for (const commitment of this.cache.extractions[path].extraction
				.commitments) {
				commitment.status = "open";
			}
		}

		const commitments: { id: string; text: string; date: string | null }[] =
			[];
		const laterSummaries: { date: string | null; summary: string }[] = [];
		for (const path of cachedPaths) {
			const entry = this.cache.extractions[path];
			const date = dateByPath.get(path) ?? null;
			laterSummaries.push({ date, summary: entry.extraction.summary });
			for (const commitment of entry.extraction.commitments) {
				commitments.push({
					id: djb2(`${path}|${commitment.text}`),
					text: commitment.text,
					date,
				});
			}
		}

		try {
			const doneIds = await this.engine.matchCommitments({
				commitments,
				laterSummaries,
			});
			const doneSet = new Set(doneIds);

			let markedDone = 0;
			for (const path of cachedPaths) {
				for (const commitment of this.cache.extractions[path].extraction
					.commitments) {
					if (doneSet.has(djb2(`${path}|${commitment.text}`))) {
						commitment.status = "done";
						markedDone += 1;
					}
				}
			}
			return markedDone;
		} catch (error) {
			// Never surface to the user: leave every commitment open and move on.
			console.warn(
				"[Periodic Notes Synthesizer] Commitment matching failed; leaving all commitments open.",
				error
			);
			return 0;
		}
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
				lines.push("");
				const synthesis = this.cache.themeSyntheses[theme.topic];
				if (synthesis) {
					lines.push(synthesis.consensus);
					lines.push("");
					if (synthesis.tension) {
						lines.push(`Tension: ${synthesis.tension}`);
						lines.push("");
					}
				}
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

class ProUpgradeModal extends Modal {
	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Free limit reached" });

		contentEl.createEl("p", {
			text: "You've used all 3 free syncs. You can still generate reports from already-synced content at any time — new syncs require a Pro license.",
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		const getProBtn = buttonRow.createEl("button", {
			text: "Get Pro license",
			cls: "mod-cta",
		});
		getProBtn.addEventListener("click", () => {
			window.open(GUMROAD_URL, "_blank");
		});

		const gotItBtn = buttonRow.createEl("button", { text: "Got it" });
		gotItBtn.addEventListener("click", () => {
			this.close();
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
