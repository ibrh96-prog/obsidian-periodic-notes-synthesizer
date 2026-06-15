import type { LLMAdapter } from "./llm";

/**
 * Pure synthesis engine. No Obsidian API, no clock, no vault I/O — the only
 * outside contact is the network, and that only through the injected
 * {@link LLMAdapter}. Phase 2 is a skeleton: the constructor and adapter field
 * exist so the class compiles and is importable. The real logic lands in
 * Phase 3.
 */
export class SynthesisEngine {
	private readonly adapter: LLMAdapter;

	constructor(adapter: LLMAdapter) {
		this.adapter = adapter;
	}

	// Phase 3: per-note extraction
	// Phase 3: per-theme synthesis
}
