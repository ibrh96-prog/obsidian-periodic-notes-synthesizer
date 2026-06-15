import { App, PluginSettingTab, Setting } from "obsidian";
import type PeriodicNotesSynthesizerPlugin from "./main";

export type LLMProvider = "anthropic" | "openai-compatible";

/** Floor for the stale threshold; flagging anything younger than a week would
 * just be noise. */
export const STALE_DAYS_MIN = 7;

export interface PeriodicNotesSettings {
	provider: LLMProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	dailyNotesFolder: string;
	periodicTag: string;
	staleDays: number;
	proLicenseKey: string;
}

export const DEFAULT_SETTINGS: PeriodicNotesSettings = {
	provider: "anthropic",
	apiKey: "",
	baseUrl: "",
	model: "claude-sonnet-4-6",
	dailyNotesFolder: "Daily Notes",
	periodicTag: "daily",
	staleDays: 90,
	proLicenseKey: "",
};

export class PeriodicNotesSettingTab extends PluginSettingTab {
	private readonly plugin: PeriodicNotesSynthesizerPlugin;

	constructor(app: App, plugin: PeriodicNotesSynthesizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Language model section ---
		new Setting(containerEl).setName("Language model").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Which API shape to use for synthesis requests.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("anthropic", "Anthropic")
					.addOption("openai-compatible", "OpenAI-compatible")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as LLMProvider;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Stored locally in this vault. Never committed or shared.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("API endpoint root, without a trailing slash.")
			.addText((text) => {
				text
					.setPlaceholder("Leave empty for default")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model identifier passed to the provider.")
			.addText((text) => {
				text
					.setPlaceholder("claude-sonnet-4-6")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- Note detection section ---
		new Setting(containerEl).setName("Note detection").setHeading();

		new Setting(containerEl)
			.setName("Daily notes folder")
			.setDesc("Folder containing your daily/periodic notes")
			.addText((text) => {
				text
					.setPlaceholder("Daily Notes")
					.setValue(this.plugin.settings.dailyNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Daily note tag")
			.setDesc("Tag identifying a daily/periodic note, without #")
			.addText((text) => {
				text
					.setPlaceholder("daily")
					.setValue(this.plugin.settings.periodicTag)
					.onChange(async (value) => {
						this.plugin.settings.periodicTag = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Stale after (days)")
			.setDesc("Open loops older than this are flagged")
			.addText((text) => {
				text
					.setPlaceholder("90")
					.setValue(String(this.plugin.settings.staleDays))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.staleDays = Number.isNaN(parsed)
							? DEFAULT_SETTINGS.staleDays
							: Math.max(STALE_DAYS_MIN, parsed);
						await this.plugin.saveSettings();
					});
			});

		// --- License section ---
		new Setting(containerEl).setName("License").setHeading();

		new Setting(containerEl)
			.setName("Pro license key")
			.setDesc("Paste your license key to unlock unlimited syncs")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.proLicenseKey)
					.onChange(async (value) => {
						this.plugin.settings.proLicenseKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setDesc("Free tier: 3 syncs total.");
	}
}
