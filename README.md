![](https://github.com/Dr-Toru/dr-toru/blob/main/src-tauri/icons/128x128%402x.png)

# Dr. Toru

Offline medical dictation app. Record, transcribe, and generate clinical
notes -- all locally. Patient data never leaves your device.

## Features

- **Speech-to-text** -- transcribe medical dictation using a
  locally-running speech recognition model
- **AI-powered notes** -- optionally generate corrected transcripts and
  SOAP notes using a local language model
- **Fully offline** -- everything runs on your device, so patient data
  never leaves the machine
- **Pluggable models** -- swap in different speech recognition or
  language models as they become available

## Installation

Download the latest release for your platform from the
[Releases](https://github.com/Dr-Toru/dr-toru/releases) page:

- **macOS** -- `.dmg`
- **Windows** -- `.msi` or `.exe`

### Setting up transcription

After installing, you'll need to download a speech recognition model:

1. Go to the [plugins page](https://github.com/Dr-Toru/dr-toru/releases/tag/plugins)
   and download a Dictation plugin.
2. Open Dr. Toru, go to **Settings**, and import the downloaded file.

### Enabling AI notes (optional)

To generate corrected transcripts and SOAP notes, import a `.llamafile`
language model from the same Settings screen.

---

## Development

### Prerequisites

- [pnpm](https://pnpm.io/) 10+
- Tauri 2 system dependencies
  ([macOS](https://v2.tauri.app/start/prerequisites/#macos) /
  [Windows](https://v2.tauri.app/start/prerequisites/#windows))

### Getting started

```bash
pnpm install
pnpm tauri dev
```

### Building

```bash
pnpm tauri build
```

### Testing

```bash
pnpm test            # unit tests (vitest)
pnpm check           # typecheck + lint + format check
```

### Project layout

```
src/                  # TypeScript frontend
  app/                #   dictation controller, recording service, UI
  plugins/            #   plugin contracts, registry, runtime adapters
  asr.worker.ts       #   ASR inference (Web Worker)
src-tauri/            # Rust backend
  src/plugins/        #   plugin storage, import, llamafile runtime
  src/storage.rs      #   recording persistence
```
