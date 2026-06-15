import { App, TFile, getAllTags, type CachedMetadata } from "obsidian";
import type { PeriodicNotesSettings } from "./settings";
import type { PeriodicNote } from "./types";

/**
 * Gathers daily/periodic notes from the vault. Pure collection — no LLM calls
 * and no body reading. A note qualifies if it lives under the configured
 * folder OR carries the configured tag.
 */
export class PeriodicNoteCollector {
	private readonly app: App;
	private readonly settings: PeriodicNotesSettings;

	constructor(app: App, settings: PeriodicNotesSettings) {
		this.app = app;
		this.settings = settings;
	}

	async collect(): Promise<PeriodicNote[]> {
		const notes: PeriodicNote[] = [];
		const seen = new Set<string>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isPeriodicNote(file)) {
				continue;
			}
			if (seen.has(file.path)) {
				continue;
			}
			seen.add(file.path);
			notes.push(this.toPeriodicNote(file));
		}

		return notes;
	}

	private isPeriodicNote(file: TFile): boolean {
		return this.matchesFolder(file) || this.matchesTag(file);
	}

	private matchesFolder(file: TFile): boolean {
		const folder = this.settings.dailyNotesFolder.trim().replace(/\/+$/, "");
		if (folder === "") {
			return false;
		}
		return file.path === folder || file.path.startsWith(`${folder}/`);
	}

	private matchesTag(file: TFile): boolean {
		const wanted = this.normalizeTag(this.settings.periodicTag);
		if (wanted === "") {
			return false;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			return false;
		}
		const tags = getAllTags(cache) ?? [];
		return tags.some((tag) => this.normalizeTag(tag) === wanted);
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, "").toLowerCase();
	}

	private toPeriodicNote(file: TFile): PeriodicNote {
		const cache = this.app.metadataCache.getFileCache(file);
		return {
			path: file.path,
			title: file.basename,
			mtime: file.stat.mtime,
			date: this.parseNoteDate(file, cache),
		};
	}

	/**
	 * Derive the note's own calendar date as YYYY-MM-DD. Try, in order:
	 * (a) the frontmatter "date" field, (b) the filename. Pure string parsing —
	 * never `new Date()` — so locale and timezone can't shift the result.
	 * Returns null when nothing parses.
	 */
	private parseNoteDate(file: TFile, cache: CachedMetadata | null): string | null {
		const fromFrontmatter = this.parseDate(cache?.frontmatter?.["date"]);
		if (fromFrontmatter !== null) {
			return fromFrontmatter;
		}
		return this.parseDate(file.basename);
	}

	/**
	 * Normalize a date string to YYYY-MM-DD. Accept ISO ("2026-06-13" or a full
	 * timestamp, sliced to the date) and European "DD.MM.YYYY" ("13.06.2026").
	 * Split and pad manually; never `new Date()`. Anything unrecognized returns
	 * null rather than guessing.
	 */
	private parseDate(value: unknown): string | null {
		const raw = this.asString(value);
		if (raw === null) {
			return null;
		}

		const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
		if (iso) {
			return `${iso[1]}-${iso[2]}-${iso[3]}`;
		}

		const european = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
		if (european) {
			return `${european[3]}-${european[2]}-${european[1]}`;
		}

		return null;
	}

	/** Non-empty trimmed string, or null for anything else. */
	private asString(value: unknown): string | null {
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed === "" ? null : trimmed;
	}
}
