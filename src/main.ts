import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PeriodicNotesSettingTab,
	type PeriodicNotesSettings,
} from "./settings";
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

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new PeriodicNotesSettingTab(this.app, this));

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
