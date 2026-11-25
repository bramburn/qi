# tools/docgen

Local, incremental documentation generator for the qi docs site (`website/`).

It reads source files, asks a **local** llama.cpp model to write Docusaurus MDX
pages, gates the result (brand rules + `docusaurus build`), repairs failures,
and opens a pull request against `fork/main`. Generation never leaves the
machine: the only network calls are to the local model server and to GitHub at
the very end (push + PR).

The model server runs on its **own port**, `8081` by default. Port `8080` on this
machine is a long-running reranker (`qwen3-reranker-0.6b`); docgen never assumes
it, binds it or reclaims it. Never `taskkill /IM llama-server.exe` - several
`llama-server` instances serve different purposes, so stop only the docgen PID
after checking its command line.

This directory is **not** a Bun workspace package. It has no runtime code and is
not imported by any `packages/*` package.

## Pipeline

```
scan_changes ──► plan_pages ──► write_page ×N ──► assemble ──► brand_check ──► build_validate
     │                                                                              │
     │ no relevant changes                                                          ├─ errors & repair_round < 2 ──► repair ──► brand_check
     ▼                                                                              ├─ clean ──► publish ──► END
    END                                                                             └─ exhausted ──► halt ──► END
```

| Node | What it does |
| --- | --- |
| `scan_changes` | `git diff` since the last published commit (from `.docgen/manifest.json`), filtered to `packages/` and `specs/` sources |
| `plan_pages` | The triage model maps changed files to at most 5 page targets (structured output), then a deterministic filter drops tasks whose sources are unchanged |
| `write_page` | One H2 section per model call (`QI_DOCGEN_SECTIONED`, default on), assembled deterministically; reference API sections are further batched five declarations at a time. Each call gets the source slices (24k chars max) plus a field index of every exported object type. With `QI_DOCGEN_SECTIONED=0` it falls back to whole-page generation |
| `assemble` | Writes the generated MDX into `website/docs/` |
| `brand_check` | Regex gate over generated pages: no `pi.dev`, `@earendil-works`, `PI_*`, upstream links |
| `build_validate` | `npm run build` in `website/` (`onBrokenLinks: 'throw'`, so a pass is a real link check) |
| `repair` | Feeds build/brand errors back to the model for the failing pages, at most twice |
| `publish` | Branch, explicit-path `git add`, commit, push to `fork`, `gh pr create --base main` - never merged automatically |
| `halt` | Gives up after two repair rounds and leaves the files for a human |

`publish` is the only place that touches git or GitHub, and it is skipped
entirely by `--dry-run`.

Three things are deterministic rather than trusted to the model: the frontmatter
(id/title/sidebar_label from the page path), the page skeleton per kind, and link
sanitising - a relative `.md`/`.mdx` link whose target does not exist on disk is
unwrapped to plain text, because `onBrokenLinks: 'throw'` would reject the page.

Before any model call, `preflight()` (`docgen/server.py`) checks the configured
endpoint. A missing server, a different model id, or a reranker answering on that
port is a hard stop with an explanation - never a reason to kill a process.

## Prerequisites

- Python 3.11+
- Node 22+ and website dependencies: `cd website && bun install --frozen-lockfile`
- `gh` authenticated for `bramburn/qi`
- A local `llama-server` exposing an OpenAI-compatible API

## Start the model server

Quality variant (Q4_K_M, MoE experts in system RAM - needs roughly 32 GB RAM and
a 12 GB GPU). Note the port: `8081`, not `8080`:

```powershell
llama-server.exe -m C:\dev\llama.cpp\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf `
  -c 16384 -ngl 99 --n-cpu-moe 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --port 8081 --alias doc-writer
```

Speed variant (IQ2_XS, entirely on a 12 GB GPU):

```powershell
llama-server.exe -m C:\dev\llama.cpp\models\Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated-i1-IQ2_XS.gguf `
  -c 16384 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --port 8081 --alias doc-writer
```

8080 is the reranker. Do not start docgen there, do not stop what owns it, and do
not kill by image name - several `llama-server` processes run on this machine.

The model alias must match `QI_DOCGEN_LLM_MODEL` (default `doc-writer`):

| Variable | Default |
| --- | --- |
| `QI_DOCGEN_LLM_BASE_URL` | `http://127.0.0.1:8081/v1` |
| `QI_DOCGEN_LLM_MODEL` | `doc-writer` |
| `QI_DOCGEN_LLM_API_KEY` | `local` |
| `QI_DOCGEN_SECTIONED` | `1` (one H2 section per call; `0` = whole page) |

## Install

```powershell
cd tools/docgen
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

## Usage

```powershell
# Wiring check: compiles the graph, no model calls, no writes.
.venv\Scripts\python run.py --check

# Write pages and build, but take no git/PR actions.
.venv\Scripts\python run.py --dry-run

# Incremental run: regenerate pages affected by source changes since the last
# published manifest, then open a PR.
.venv\Scripts\python run.py

# First run: migrate packages/coding-agent/docs/*.md into website/docs/.
.venv\Scripts\python run.py --bootstrap --dry-run
```

Nightly incremental runs are meant to be scheduled with Windows Task Scheduler
pointing at `run.py`. A run with no relevant source changes exits after
`scan_changes` without touching the model.

## State

`tools/docgen/.docgen/` is gitignored:

- `manifest.json` - page path to `{source_paths, hashes, generated_at}`, plus the
  `last_commit` the incremental diff is taken from. Written only after a
  successful build and publish.
- `checkpoints.db` - LangGraph `SqliteSaver` checkpoints.
- `eval-runs/` - raw output from `eval/run_eval.py`.

## Prompt tuning

`eval/` holds a golden-task harness used to tune the prompts against the actual
quantized model. `eval/PROMPTS_LOG.md` records every round: model and serving
flags, diagnosis, change class, gate failures, judge scores, and the known
limitations. Run it with the server up:

```powershell
.venv\Scripts\python eval\run_eval.py --round 0
.venv\Scripts\python eval\run_eval.py --round 1 --repeat 2
.venv\Scripts\python eval\run_eval.py --round 2 --task ref-ai-types
```

Raw outputs and `report.json` per round go to `.docgen/eval-runs/round-<n>/`,
which is gitignored. The harness calls the same `docgen` modules the pipeline
uses, so a prompt change cannot be "tuned" in a private copy.

```powershell
# re-run every gate over an existing round, no model calls
.venv\Scripts\python eval\run_eval.py --score-only .docgen\eval-runs\round-23
```

Besides the frontmatter / fence / brand / link / coverage gates, two structural
gates catch the failure classes that prose review misses:

- `G-json` - every `json` fence must parse.
- `G-ident` - API-shaped backticked identifiers, string literals used as API
 names (`ApiOptionsMap["custom-api"]`) and compound names inside code fences
 must exist verbatim in the page's sources. Names the example defines itself
 (`const`/`let`/`var`/`type`/`function`) are exempt; `IDENT_ALLOWLIST` holds a
 short, commented list of non-API names such as `PATH`.

Add allowlist entries only after checking the source: never widen that into a
blanket exemption.

## Seed pages

The pipeline currently owns five pages, generated with the prompts described in
`eval/PROMPTS_LOG.md` and re-verified by the gates on every run:

- `website/docs/architecture/ai-package-types.mdx`
- `website/docs/architecture/extension-pinning.mdx`
- `website/docs/environment-variables.mdx`
- `website/docs/reference/docs-navigation.mdx`
- `website/docs/quickstart.mdx`

## Git policy

- `publish` pushes to the `fork` remote (`bramburn/qi`) only.
- It stages explicit paths (`git add <page> ...`), never `git add -A`.
- It opens a PR against `main` and never merges it.
- It never rewrites history and never force-pushes.

## Migrations

This tool ships and runs **no** migrations. It does not read or write
`~/.qi/agent`, session files, or any application state; its only writes are
`website/docs/**` pages and its own gitignored `.docgen/` directory.