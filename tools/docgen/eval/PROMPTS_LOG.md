# Prompt tuning log

Subject model: `Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf`, served by
`llama-server` 0.7.0 (build 7170cad):

```
-c 16384 -np 1 -t 24 -ngl 99 --n-cpu-moe 99 --load-mode none -fa on -ctk q8_0 -ctv q8_0
--jinja --port 8081 --alias doc-writer
```

Port 8081, not 8080: 8080 on this machine is a long-running reranker server.
The harness is pointed at it with `DOCGEN_BASE_URL=http://127.0.0.1:8081/v1`.

All weights (~21 GB) sit in system RAM because of `--n-cpu-moe 99`; the GPU holds
only attention weights and the KV cache (~2 GB). That is the "quality variant"
from the README: ~20 tok/s, ~90 s for a 24k-char context page.

Change classes: L1 sampling, L2 few-shot, L3 skeleton, L4 decompose, L5 context
diet, L6 rule rewrite. One class per round, diagnosis written before the edit.

---

## Pre-round-0 infrastructure fix (not a tuning round)

Diagnosis: the Qwen3.6 chat template enables thinking by default. A 6256-token
prompt produced 2169 billed output tokens for 965 characters of content - the
reasoning stream is discarded by LangChain but costs ~10x generation time.

Fix: `config.py` sends `extra_body={"chat_template_kwargs": {"enable_thinking": false}}`
on every request, and `max_tokens` drops from 6000 to 3000 so that
`prompt + max_tokens` always fits the 16384 window (6000 output tokens were
rejected with HTTP 400 on long prompts).

Measured effect: 4.3 tok/s -> 19.9 tok/s; a 24k-char page drops from ~10 minutes
to ~90 s.

## Round 0 - baseline - unmodified Phase 3 prompts

Change class: none.

5 generations, 4 gate failures.

| task | s | chars | gate failures |
| --- | --- | --- | --- |
| ref-ai-types | 92.9 | 5482 | none |
| guide-env-vars | 75.0 | 5074 | `typescript` fence x2 |
| arch-extensions | 50.6 | 3532 | `E_EXT_NO_COMPATIBLE_VERSION` absent |
| tutorial-quickstart | 75.7 | 5076 | `markdown` fence |
| ref-docs-nav | 43.9 | 3478 | none |

Judge scores (F/C/U/B out of 3):

| task | F | C | U | B | note |
| --- | --- | --- | --- | --- | --- |
| ref-ai-types | 3 | 3 | 3 | 3 | real API surface; `pi-messages` is a literal enum in `types.ts` and was annotated rather than renamed |
| guide-env-vars | 3 | 2 | 3 | 3 | faithful but a near-verbatim copy, and it copies `providers.md` links that do not exist under `website/docs/` |
| arch-extensions | 3 | 3 | 3 | 3 | Problem/Solution structure; `R-EXT-001..008`, `ADR-0003`, `CONTRACT-EXT-COMPAT-MANIFEST` verified present in the feature file |
| tutorial-quickstart | 3 | 2 | 3 | 3 | correct install commands, `markdown` fence tag |
| ref-docs-nav | 3 | 3 | 3 | 3 | clean |

Verdict: KEEP (baseline).

## Round 1 - gate fix, prompts unchanged

Diagnosis: two round-0 failures were harness bugs. `typescript` and `markdown`
are valid fence tags, and the link gate only checked links starting with `./` or
`../`, so the verbatim `providers.md` links (which Docusaurus cannot resolve and
`onBrokenLinks: 'throw'` rejects) went unreported.

Change: `eval/run_eval.py` - fence whitelist extended; the link gate now checks
every relative `.md`/`.mdx` link and skips absolute URLs and root-relative paths.

Results: 16 gate failures.

| task | s | chars | gate failures |
| --- | --- | --- | --- |
| ref-ai-types | 167.5 | 11418 | unbalanced code fences |
| guide-env-vars | 72.9 | 5074 | `providers.md` x2, `terminal-setup.md` |
| arch-extensions | 67.2 | 5337 | none |
| tutorial-quickstart | 74.3 | 5056 | `markdown` fence + 11 `.md` links |
| ref-docs-nav | 69.8 | 4548 | none |

Diagnosis: `ref-ai-types` hit `max_tokens=3000` mid-fence (11418 chars versus
5482 in round 0) - cause class (d), sampling. The `.md` links are format drift
(class b): the model mirrors markdown links out of a `.md` source file, which no
amount of prohibition had fixed at round 0. The `markdown` fence tag was still
outside the whitelist except as `md`; that is a gate gap, fixed here.

Verdict: KEEP the gate fix; prompts unchanged.

## Round 2 - L1: raise max_tokens to 4096

Diagnosis: truncation only (class d). 4096 output tokens still leaves headroom
under the 16384 context for a 24k-char source.

Results: 15 gate failures - `ref-ai-types` fixed, the `.md` link problem
unchanged (3 failures in `guide-env-vars`, 12 in `tutorial-quickstart`).

Verdict: KEEP.

## Round 3 - L2: one few-shot exemplar in `WRITE_SYSTEM`

Diagnosis: class (b) format drift. Small models imitate an example far better
than they follow a list of prohibitions, so `WRITE_SYSTEM` gained one 30-line
ideal MDX page (`WRITE_EXAMPLE`), explicitly labelled as a format model whose
names, commands and values must not be reused, plus one line about linking.

Results: 15 gate failures - no improvement on links (13), plus the
`E_EXT_NO_COMPATIBLE_VERSION` coverage miss returned and one `markdown` fence.

Diagnosis: the exemplar fixed tone and structure but not source-copying. The
sources are large enough that the model copies their shape, including a
"next steps" link list. Need to constrain the page structure itself: L3.

Verdict: KEEP the exemplar, add structure.

## Round 4 - L3: forced section skeleton per kind

Diagnosis: the model reproduces the source document layout (including its link
list) because nothing tells it what sections a qi page has.

Change: `prompts.write()` now sends a per-kind skeleton, states that the
frontmatter is already written, forbids `Next steps` / `See also` sections, and
asks for real content in every section.

Results: 15 -> 2 gate failures.

| task | chars | gate failures |
| --- | --- | --- |
| ref-ai-types | 3278 | `samplingParams` absent |
| guide-env-vars | 2422 | none |
| arch-extensions | 2570 | none |
| tutorial-quickstart | 1766 | `markdown` fence |
| ref-docs-nav | 1940 | none |

Verdict: KEEP - this is the round where the link-copying stopped.

## Round 5 - L3 continuation: section content contract

Diagnosis: average page length halved and the "API surface" section became a
stub, so required symbols went missing. The skeleton needed a content contract,
not just headings. Also: `markdown` is a legitimate fence tag and belongs in the
whitelist.

Change: "every section needs two short paragraphs, a table, or a code block";
"in an API surface section, list every exported type, interface and function".

Results: 2 gate failures (`ref-ai-types` missing `Model` and `samplingParams`).

Diagnosis: `Model` is declared at character 35999 of `types.ts`, past the
24000-character context budget. That is not a prompt failure - the model was
never shown the declaration. Cause class (c) context, mitigation L5.

Verdict: KEEP; next round attacks the context.

## Round 6 - L5: symbol-level context diet

Diagnosis: a blind character prefix silently drops the declarations at the end
of a large file, which are exactly the ones a reference page must document.

Change: new `docgen/context.py` with `read_sources()` / `source_slice()`: when a
source exceeds the budget, keep the head and append an index of every exported
declaration that fell past the cut. `nodes.write_page` and
`eval/run_eval.py:build_context` both call it, so tuning measures production
behaviour rather than a private copy.

Results: 1 gate failure (`samplingParams` absent, `ref-ai-types` now 5465 chars).

Diagnosis: `samplingParams` is a field of `StreamOptions`/`Model`, not an
exported symbol, so the export index does not surface it. The API-surface
contract must ask for the fields that matter, not only the declarations.
Class (b)/L3 continuation.

Verdict: KEEP.

## Round 7 - L3 continuation, measured at --repeat 2

Change: "name the fields that matter for callers (options and parameters
included)".

Results: 10 generations, 2 gate failures - `ref-ai-types` run0 missing
`samplingParams`, `guide-env-vars` run1 with a stray `providers.md` link.

Diagnosis: both failures are run-to-run variance at `temperature=0.2`, not a
systematic prompt defect (each task passed on the other run). Nightly runs must
be reproducible, so the honest lever is greediness: L1, temperature 0.

Verdict: KEEP the contract.

## Round 8 - L1: temperature 0

Results: 10 generations, 6 gate failures - and run0/run1 are byte-identical per
task (this round is also the evidence that temperature 0 makes the model
deterministic on this server).

Diagnosis: greedy decoding locked in the 3 tasks' previously unlucky variant.
Every failure is the same defect: a copied `providers.md` / `terminal-setup.md`
link. Two rounds of prompt rules and one exemplar did not remove it, and no
`max_tokens` or context change can: the pages are 1.6k-5.4k chars and finish
normally, the link is simply wrong for the target site. Docusaurus would reject
the page (`onBrokenLinks: 'throw'`), so the pipeline would spend a 90 s repair
call on a mechanical defect. Deterministic fix instead.

Change: `prompts.sanitize_links()` - a relative `.md`/`.mdx` link whose target
does not exist on disk is unwrapped to its text. Applied inside
`ensure_frontmatter`, so write, repair and the eval harness all get it.

Verdict: KEEP temperature 0; add the link guard.

## Round 9 - confirmation, --repeat 2

Results: 10 generations, **0 gate failures**.

## Round 10 - confirmation, --repeat 2

Results: 10 generations, **0 gate failures**.

Judge review of round 10 (F/C/U/B):

| task | F | C | U | B | note |
| --- | --- | --- | --- | --- | --- |
| ref-ai-types | 2 | 3 | 3 | 3 | invented `defineTool`, `@bramburn/qi-typebox` and a `qi stream` command - none exist in the repo |
| guide-env-vars | 3 | 3 | 3 | 3 | accurate, links now unwrapped |
| arch-extensions | 2 | 3 | 3 | 3 | invented `interface CompatibilityEntry` to illustrate the manifest format |
| tutorial-quickstart | 3 | 3 | 3 | 3 | accurate install steps |
| ref-docs-nav | 3 | 3 | 3 | 3 | accurate |

Diagnosis: the exemplar contains a code block, so the model fills the
`Example`/`Design` sections with invented runnable code when the source offers
no example. Cause class (c) - the task is open-ended about examples. Mitigation:
L6, an explicit evidence rule.

Verdict: gate-clean but Faithfulness 2/3 on two pages, so the prompts were not
done.

## Round 11 - L6: evidence rule for examples

Change: "Every identifier, package name, CLI command, flag, config key and file
path you write must appear verbatim in the source material... build the example
only from symbols defined in it, or leave the code block out" and "Do not invent
an interface or type definition to illustrate a format". Also made the
deterministic title casing acronym-aware (`AI`, `TUI`, `SDK`, `RPC`, `CLI`,
`JSON`, `API`) so `ai-package-types` is no longer titled "Ai Package Types".

Iterated on the two failing tasks only (2 generations, 0 gate failures), then:

## Round 12 - final measurement, round-11 prompts

Results: 5 generations, **0 gate failures**.

| task | chars |
| --- | --- |
| ref-ai-types | 7220 |
| guide-env-vars | 4745 |
| arch-extensions | 4026 |
| tutorial-quickstart | 2367 |
| ref-docs-nav | 1930 |

Judge review of round 12:

| task | F | C | U | B | note |
| --- | --- | --- | --- | --- | --- |
| ref-ai-types | 2 | 3 | 3 | 3 | `defineTool` / `qi stream` gone; still shows `ApiOptionsMap["custom-api"]`, which is not valid TypeScript - `ApiOptionsMap` has no index signature, so the fallback is `ApiStreamOptions<TApi>` |
| guide-env-vars | 3 | 3 | 3 | 3 | accurate |
| arch-extensions | 2 | 3 | 3 | 3 | still illustrates the manifest with a JSON object whose keys are not in the source (values are from the Gherkin background) |
| tutorial-quickstart | 3 | 3 | 3 | 3 | accurate |
| ref-docs-nav | 3 | 3 | 3 | 3 | accurate |

Verdict: KEEP (best version), with the limitation recorded below.

## Repair path check

A round-12 page was deliberately corrupted (removed `sidebar_label`, injected
`PI_OFFLINE=1` into the Problem section), then run through `prompts.repair` +
`gates`. One iteration: both gate errors cleared (`PI_OFFLINE` gone,
`sidebar_label` restored). `REPAIR_SYSTEM` needs no ladder work.

## Keep / revert decision

Reverted: the five round-12 pages were copied into their `doc_path` locations,
`bun run build` in `website/` passed (exit 0, so the gates match the real
Docusaurus build), and they were then removed from the tree rather than
committed. Two of five pages still carry unverifiable claims (above), and a
seed page sets the style baseline for everything generated afterwards.

## Final configuration

- Serving: `-c 16384 -np 1 -t 24 -ngl 99 --n-cpu-moe 99 --load-mode none -fa on
  -ctk q8_0 -ctv q8_0 --jinja`, port 8081, alias `doc-writer`.
- Sampling: `temperature=0`, `max_tokens=4096`, `chat_template_kwargs.enable_thinking=false`,
  no repetition penalty or `min_p` (neither was needed once thinking was off).
- Prompts: `WRITE_SYSTEM` = brand rules + 9 hard rules + one exemplar;
  per-kind skeleton sent in the user message; `sanitize_links` guardrail.
- `SECTIONED` decomposition (L4) was not required: the model writes a full page
  correctly at L3.
- Gate stability: rounds 9 and 10 at `--repeat 2` (10 generations each) showed
  zero gate failures; round 12 confirmed zero on the final prompts.

## Known limitations and recommended next lever

1. **Faithfulness on illustrative code (2/5 pages).** When the source has no
   example, the model still invents one (a JSON manifest shape for
   `arch-extensions`, an invalid `ApiOptionsMap["custom-api"]` lookup for
   `ref-ai-types`). The 8-round cap was already exceeded at round 11, so this
   was left in place. Next lever: **L4 decomposition with an example-free
   skeleton** - drop the `Example` section for reference pages whose source has
   no runnable snippet, and gate the section list deterministically instead of
   asking the model to decide.
2. **Determinism versus stability evidence.** Rounds 9/10 legitimately ran the
   same prompts twice with zero failures, but at `temperature=0` both rounds are
   byte-identical (visible in round 8), so they demonstrate determinism rather
   than variance robustness. If variance robustness matters, the next step is
   temperature 0.2 plus the L4 decomposition, not more wording.
3. **One model only.** Every result above is the Q4_K_M CPU-MoE server. The
   IQ2_XS variant was never tested because only ~3.5 GB of the 12 GB card was
   free with the desktop applications running.
4. **Gate coverage.** The gates check frontmatter, fences, brand, relative
   links, required symbols and length. They cannot detect a plausible but wrong
   API name - that is exactly the failure that survived, which is why the judge
   pass existed.
---

# L4 addendum - sectioned generation and hallucination gates

Same model and serving flags as above (`doc-writer`, port 8081). One change per
round. Rounds 13-24; two extra rounds past the nominal 8-round cap (21-24) were
spent closing the last Faithfulness axis and confirming it, which is recorded
here rather than hidden.

Whole-page generation was replaced by `write_page` -> one H2 section per LLM call
plus deterministic assembly (`QI_DOCGEN_SECTIONED`, default on). The whole-page
path is still reachable with `QI_DOCGEN_SECTIONED=0`.

## L4 addendum - Round 0 (structural ground work, no prompts)

Not a tuning round. Before touching prompts:

- `docgen/config.py` now reads `QI_DOCGEN_LLM_BASE_URL` / `QI_DOCGEN_LLM_MODEL` /
  `QI_DOCGEN_LLM_API_KEY` and defaults to `http://127.0.0.1:8081/v1`. Port 8080
  belongs to the reranker and is never assumed.
- `docgen/server.py:preflight()` refuses a missing model, an unknown model and a
  reranker endpoint with an explanatory message. Called from `run.py` and from
  `eval/run_eval.py`; a mismatch is a stop, never a kill.
- `eval/run_eval.py` now drives the production writer (`nodes.write_page`)
  instead of calling `prompts.write` directly, so the harness and the pipeline
  cannot diverge.
- New gates `G-json` and `G-ident` in `structural_gates()`.

Gate calibration, run with `--score-only` over the 40 pages of rounds 0-12:

| round | G-ident hits | what they were |
| --- | --- | --- |
| 0-3 | 0 | - |
| 4,5,6,7,8,9 | 4,3,4,11,4,4 | `NavigationItem`, `DocsJson`, `compatibleConstraint`, `defaultRevision`, `Redirect`, `DocsConfig` - all genuinely absent from the sources |
| 10 | 4 | `defineTool`, `CompatibilityEntry` |
| 11,12 | 2,2 | `defaultRevision`, `ApiOptionsMap["custom-api"]` |

Both logged failure classes are now caught mechanically: the invented JSON shape
by `G-ident` on fenced names, the invented API member by `G-ident` on the string
literal inside a bracket index. Two false positives appeared and were handled as
the rule requires: local definitions (`const`/`let`/`var`/`type`/`function`) are
exempt because the example owns those names, and `PATH` / `HOME` are narrow,
commented allowlist entries because they are real OS variables. `interface`,
`class` and `enum` definitions are deliberately NOT exempt - inventing a type
shape is the failure this gate exists for.

## L4 addendum - Round 13: first sectioned run (canary only)

`ref-docs-nav`, 4 sections. Gates 0, but the page was 14 KB: the same `docs.json`
dumped three times, because every section saw only the source and no view of its
siblings. Diagnosis: section roles missing (class b, format drift).

## L4 addendum - Round 14: section roles

`SECTION_ROLES` gives every heading a job ("Three to five bullets, no code
fences"; "one minimal excerpt, at most 15 lines"), and `SECTION_SYSTEM` gained
"Do not paste the source file".

`ref-docs-nav`: 14 KB -> 2427 chars, 0 gates, 1m06.

## L4 addendum - Round 15: first full round

5 generations, 2 gate failures, 6m13, 15210 chars total.

| task | gate failures |
| --- | --- |
| ref-ai-types | `samplingParams` absent |
| arch-extensions | `E_EXT_NO_COMPATIBLE_VERSION` absent |
| guide-env-vars, tutorial-quickstart, ref-docs-nav | none |

Diagnosis: the L4 architecture skeleton had dropped "Behaviour and error paths",
which is the section the error code lived in (class c, skeleton coverage);
`ref-ai-types` lost option fields because the API role only asked for fields that
"matter".

## L4 addendum - Round 16: skeleton coverage

Restored `Behaviour and error paths` for architecture (role: condition -> outcome
-> error code, codes from the source) and made the API role ask for every
exported declaration and every field of each option interface.

`arch-extensions` PASS. `ref-ai-types` still missing `samplingParams`: the model
listed 5 of the 9 `StreamOptions` fields. Diagnosis: recall, not context length
(the field is inside the 24k slice).

## L4 addendum - Round 17: field index (context diet)

`context._member_index()` extracts `Interface -> field, field, ...` for every
exported object type, emitted as a `<field_index>` block next to the source. It
surfaced `StreamOptions: onResponse, temperature, samplingParams, ...` in the
prompt. Still 1 gate failure: the model summarised the list anyway.

## L4 addendum - Round 18: rule pointing at the index

Rule 7: "When you name a type, list every field the index gives for it - do not
summarise". Result was worse, not better: the API section stopped listing fields
at all (all 30 types reduced to one-line descriptions). Diagnosis: a 30-declaration
enumeration does not fit one generation, so the instruction cannot be followed
(class d, task size) - this is what L4 decomposition is for.

## L4 addendum - Round 19: decompose the API section

For `kind == "reference"`, the API section is now generated in batches of five
declarations (`API_BATCH`), each call given only that batch's index entries, and
concatenated deterministically under one `## API` heading. 8 calls.

`ref-ai-types` PASS, 1m16, 6.4 KB page, all 37 declarations with all fields, real
`AssistantMessage` excerpt in Example. Faithfulness 3.

## L4 addendum - Round 20: full round

5 generations, **0 gate failures**, 4m45, 20182 chars.

Judge review found one Faithfulness defect the gates cannot see: the tutorial
showed `qi version` (there is no such subcommand - the CLI reads
`parsed.version`, i.e. `qi --version`) and an invented `qi 0.1.0 [bramburn]`
output. Class (e), invented expected output.

## L4 addendum - Round 21: no invented outputs

Rule 8: "Never invent a version number, command flag, subcommand, exit code or
output line", and the Verify role now says to show expected output only when the
source gives it.

`tutorial-quickstart`: the invented version is gone, the command is back to the
documented `qi <version> [bramburn]` format. One gate failure - `PATH` - a
genuine gate false positive, fixed as a narrow allowlist entry plus the missing
allowlist check in the backticked-symbol loop.

## L4 addendum - Round 22: confirmation, --repeat 2

10 generations, **0 gate failures**, 10m13.

## L4 addendum - Round 23: confirmation, --repeat 2

10 generations, **0 gate failures**, 8m17. Byte-identical to round 22 and
run0 == run1 for every task, so the two confirmation rounds demonstrate
determinism rather than sampling robustness (temperature is still 0).

Judge scores (round 23): Faithfulness 3/3 on all five pages.

| task | F | C | U | B | note |
| --- | --- | --- | --- | --- | --- |
| ref-ai-types | 3 | 3 | 3 | 3 | full API surface from the field index; real excerpt |
| guide-env-vars | 3 | 3 | 3 | 3 | 17 variables, session-variable split explained |
| arch-extensions | 3 | 3 | 3 | 3 | error-path table with the real codes |
| tutorial-quickstart | 3 | 3 | 2 | 3 | `qi <version> [bramburn]` is a format placeholder shown in a bash fence |
| ref-docs-nav | 3 | 3 | 2 | 3 | API/Example/Notes still overlap somewhat |

## L4 addendum - Round 24: seed-page path correction

`eval/tasks.json` pointed the tutorial at `website/docs/quickstart-generated.mdx`,
which would have published a page titled "Quickstart Generated". The task's
`doc_path` is now `website/docs/quickstart.mdx`; one regeneration, 0 gate
failures, title `Quickstart`. No prompt change, so rounds 22/23 still cover the
shipped prompts.

## Seed pages: KEEP

All five final pages were copied to their `doc_path`s and `bun run build` in
`website/` exited 0. Unlike the previous addendum, they are committed: every page
now scores Faithfulness 3/3 and the two gates that caught the earlier inventions
run on every future generation.

## Repair path

A seed page was corrupted with three defects at once (`sidebar_label` removed,
`PI_OFFLINE=1` injected, `ManifestSchemaValidator` invented). `prompts.repair` +
`gates` + `structural_gates` cleared all three in **one** iteration: the brand
leak became `QI_OFFLINE`, the invented identifier was removed and the sentence
rewritten using a name the source really has, and the four `## ` headings were
preserved.

## Known limitations

1. **Usefulness 2/3 on two pages.** The tutorial shows the version format inside
   a bash fence, which a reader could paste; the docs-navigation page repeats its
   structure across API/Example/Notes. Both pass the >=2 bar; a human edit would
   fix them faster than another prompt round.
2. **Section count is fixed per kind.** `SKELETONS` decides the page shape before
   any source is read, so a source that needs an extra section (a changelog, a
   migration note) does not get one. Next lever: let `plan_pages` choose headings
   from the source, with the skeleton as the fallback.
3. **Field index is TS-only.** `_member_index` parses `export interface|type|class`
   blocks, so reference pages for JSON/TOML-shaped sources still rely on
   `G-ident` to catch inventions rather than on an index that prevents them.
4. **Determinism is assumed for stability, variance is untested.** `temperature=0`
   makes rounds 22 and 23 identical. Reproducibility was the goal (nightly job),
   but a warmed-up different sampler was never tested.
