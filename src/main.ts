import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PeriodicNotesSettingTab,
	type PeriodicNotesSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { PeriodicNoteCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import { emptyCache, type SynthesisCache } from "./types";

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
