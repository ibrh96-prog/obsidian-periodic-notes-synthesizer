export interface PeriodicNote {
	path: string;
	title: string;
	mtime: number;
	date: string | null; // the note's own date YYYY-MM-DD (from filename or frontmatter), null if undetectable
}

export interface Commitment {
	text: string;
	status: "open" | "done";
}

export interface NoteExtraction {
	id: string;            // djb2 of path
	summary: string;       // 2-3 sentences in the note's own language
	topics: string[];      // lowercase canonical topics
	commitments: Commitment[]; // intentions/plans/todos stated that day; status defaults to "open"
	openLoops: string[];   // unresolved questions or pending items raised that day
	language?: string;     // ISO-639-1
}

export interface ThemeSynthesis {
	consensus: string;
	tension: string;
	language?: string;
}

export interface SynthesisCache {
	extractions: Record<string, { mtime: number; extraction: NoteExtraction }>;
	themeSyntheses: Record<string, ThemeSynthesis>;
}

export function emptyCache(): SynthesisCache {
	return { extractions: {}, themeSyntheses: {} };
}

// djb2 hash, deterministic, returns base36 string
export function djb2(input: string): string {
	let h = 5381;
	for (let i = 0; i < input.length; i++) {
		h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
	}
	return h.toString(36);
}
