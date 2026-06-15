# Periodic Notes Synthesizer

An Obsidian plugin that turns your accumulated daily and periodic notes into an upper-level synthesis: monthly and quarterly rollups, recurring themes, open loops, and what you said versus what you did.

## The Problem

You write daily notes faithfully, but the value sinks into the pile. After a few months you have hundreds of entries and no way to see the throughline — which intentions you followed through on, which questions are still unresolved, and which themes keep recurring. This plugin reads the whole backlog and gives you one synthesis note: what each day was about, the themes that run across them, the commitments you completed versus the ones still open, and the loops that have gone stale.

This is operational synthesis of your daily-note practice — it works alongside however you already journal and capture, not in place of it. It does not reflect, prompt, or coach; it rolls up what is already there.

## Features

- **Overview** — Notes synthesized, date range, open-loop count, and commitment tally at a glance
- **Themes** — Topics shared across two or more notes, with an AI-written consensus and the tension between them
- **This week** — What you wrote in the current week (Monday start)
- **Open loops** — Unresolved questions and pending items across your notes, with stale flagging past your threshold
- **Said vs did** — Which commitments you stated were later completed, split into done and still open
- **Summaries** — A short summary and the topics of every synced note

## How It Works

1. Write your daily and periodic notes as you normally would
2. Run **Sync daily notes** from the command palette or the ribbon icon to extract summaries, topics, commitments, and open loops
3. Run **Generate periodic report** from the command palette or the ribbon icon
4. A `Periodic Synthesis.md` note is written to your vault root and opened
5. Re-run either command any time — syncing is incremental, so unchanged notes are never re-processed

## Setup

1. Install the plugin from Obsidian Community Plugins
2. Go to **Settings → Periodic Notes Synthesizer**
3. Select your AI provider (Anthropic, OpenAI, OpenRouter, or custom)
4. Enter your API key
5. Set your daily notes folder (default `Daily Notes`) or daily note tag (default `daily`)
6. Run **Sync daily notes**, then **Generate periodic report**

## Supported AI Providers

- **Anthropic** — Claude models (recommended: `claude-sonnet-4-6`)
- **OpenAI** — GPT models (recommended: `gpt-4o-mini`)
- **OpenRouter** — Access to many models including free options (recommended: `meta-llama/llama-4-maverick`)
- **Custom** — Any OpenAI-compatible endpoint

## Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Daily note syncs | 3 total | Unlimited |
| Periodic report | Unlimited | Unlimited |
| All AI providers | ✅ | ✅ |
| Cross-note themes | ✅ | ✅ |

The free tier allows 3 total syncs (a one-time allowance, not a monthly reset). Generating the periodic report from already-synced notes is always free. Pro is a one-time license that unlocks unlimited syncing — see the plugin's listing for purchase details.

## Privacy

- No servers, no accounts, no databases, no telemetry, and no backend data collection on our side
- Syncing sends your note content to the AI provider you configure, using your own API key, for the purpose of generating synthesis output
- Your API key is stored locally in Obsidian's data storage
- The developer does not receive, store, or have access to your notes, API key, or usage

## Support

For bugs and feature requests, open an issue on the [GitHub repository](https://github.com/ibrh96-prog/obsidian-periodic-notes-synthesizer).

## License

See [EULA.md](EULA.md) for terms of use.
