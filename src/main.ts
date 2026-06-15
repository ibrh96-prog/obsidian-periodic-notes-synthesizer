import { Plugin } from "obsidian";

export default class PeriodicNotesSynthesizerPlugin extends Plugin {
  override async onload(): Promise<void> {
    console.log("Periodic Notes Synthesizer loaded.");
  }

  override onunload(): void {}
}
