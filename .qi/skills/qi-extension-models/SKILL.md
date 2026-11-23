---
name: qi-extension-models
description: Build qi extensions that list, search, pick, or persist a model. Use when a qi extension needs the host model registry, a searchable model picker matching qi's /model behavior, a two-level drill-down fallback, or an extension-owned persisted model selection (provider, model id, and display name).
---

# qi extensions: list, search, and persist a model

Use this when building a qi extension that touches models. It records the host
APIs, the search semantics, and the persistence pattern that qi itself uses, so
the extension matches `/model` instead of reinventing it.

Verify every path and signature against the qi version the extension targets.
The host API can drift; the working example is
`bramburn/qi-compact-summariser`.

## 1. Model shape and registry API

`Model<Api>` comes from `@bramburn/qi-ai`. Fields the UI needs:

```ts
model.provider      // string, e.g. "openai" or "openrouter"
model.id            // string, may contain "/" e.g. "anthropic/claude-sonnet-4.5"
model.name          // string display name
model.api           // string wire API
model.contextWindow // number
model.maxTokens     // number, output budget
model.reasoning     // boolean
```

`ctx.modelRegistry` is `ModelRegistry`
(`packages/coding-agent/src/core/model-registry.ts`):

```ts
getAll(): Model<Api>[]                     // every known model
getAvailable(): Model<Api>[]               // models with usable config
find(provider: string, modelId: string): Model<Api> | undefined
hasConfiguredAuth(model: Model<Api>): boolean
getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>
complete<TApi extends Api>(model, context, options?): Promise<AssistantMessage>
```

`ResolvedRequestAuth` is `{ ok: true, apiKey?, headers?, baseUrl?, env? }` or
`{ ok: false, error }`. Always check `auth.ok` before offering to select a
model; selecting an unauthenticated model is a warning, not a crash.

`ctx.model` is the active session model. `ctx.mode` is
`"tui" | "rpc" | "json" | "print"`; `ctx.hasUI` is true in TUI and RPC. Guard
TUI-only features with `ctx.mode === "tui"`.

## 2. Search text: use the selector variant

Source of truth:
`packages/coding-agent/src/modes/interactive/model-search.ts`. The coding-agent
entry re-exports these symbols. On a host that includes that export, import
them directly:

```ts
import {
	getModelSearchText,
	getModelSelectorSearchText,
	type ModelSearchItem,
} from "@bramburn/qi-coding-agent";
```

If the extension targets an older host that does not export them, mirror the
functions locally and name the source in a comment. Do not maintain a local copy
once the host export is available.

```ts
export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

/** Generic variant. Bare id FIRST. Do not use for a picker. */
export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/** Selector variant. This is what a picker must use. */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
```

Why: the selector variant keeps the bare id out of the leading position, so
`openai/gpt-5` ranks the genuine model above the proxy id
`openrouter/openai/gpt-5`. The generic variant reintroduces the tie. Never merge
the two functions.

Verify the expected strings byte-for-byte in a test. For
`{ id: "gpt-5", provider: "openai", name: "GPT-5" }` the selector variant is
`"openai openai/gpt-5 openai gpt-5 GPT-5"`.

## 3. Ranking

Use `fuzzyFilter` from `@bramburn/qi-tui`. It is a value export resolved by the
host alias map.

```ts
import { fuzzyFilter } from "@bramburn/qi-tui";

export function filterCandidates(candidates: Candidate[], query: string): Candidate[] {
	const trimmed = query.trim();
	if (!trimmed) return candidates;
	return fuzzyFilter(candidates, trimmed, (candidate) => candidate.searchText);
}
```

`fuzzyFilter` splits the query on whitespace and `/`, sorts by ascending score,
and is stable. Ties therefore keep the incoming order. Make that order
deterministic before filtering: output budget descending, then provider, then
model id.

Do not write a second fuzzy matcher.

## 4. Picker strategy

Inspect the host before choosing. As of qi 0.85.x:

- `ctx.ui.select(title, options, opts?)` is a **static** list. `opts` is only
 `{ signal, timeout }`. It has no search or filter option.
- `ctx.ui.custom<T>(factory, options?)` is the searchable route and works in
 TUI mode:

```ts
ctx.ui.custom<Candidate | undefined>((tui, theme, keybindings, done) => {
	return new ModelPickerComponent({ all: candidates, done });
});
```

`custom` must return a TUI `Component` (`render(width)`, `handleInput(data)`,
`invalidate()`). `done` resolves the promise exactly once. In RPC mode `custom`
is a stub, so guard with `ctx.mode === "tui"`.

Prefer strategy B (custom component), and keep strategy C (two-level
provider-then-model drill-down over `ctx.ui.select`) as the guaranteed floor for
hosts or modes without `custom`.

### Picker component rules

- Keep the full list immutable and a `visible` list filtered by `query`.
- On **any** query change: recompute `visible`, then set the highlight to row 0.
 Never clamp the previous index into the new result set. qi regression `7209`
 pins this.
- Wrap up/down navigation like qi; page by the viewport row count and clamp.
- Enter resolves `visible[index]`; Escape resolves `undefined` and must not
 mutate persisted state.
- Resolve by index, never by the rendered label. Labels are not unique.
- Truncate every rendered line with `truncateToWidth(line, width)` from
 `@bramburn/qi-tui` so a row never exceeds the viewport.
- Show unavailable/unresolvable persisted models, marked (qi regression `6949`),
 not silently dropped.

### Key input

`matchesKey(data, keyId)` from `@bramburn/qi-tui` takes plain key ids, not
`tui.select.*` keybinding names. Use:

`"escape"`, `"enter"`, `"up"`, `"down"`, `"pageUp"`, `"pageDown"`,
`"backspace"`, `"ctrl+c"`.

`parseKeyId` lowercases the id, so `"pageUp"` and `"pageup"` both work, but the
TypeScript `KeyId` type expects the camelCase form. Do not feed raw escape
sequences to `matchesKey`; feed the actual input `data` and the key id.

### Drill-down labels

For `ctx.ui.select`, labels must be unique or a later candidate shadows an
earlier one. Build options as `{ label, candidate }[]` and suffix duplicates:

```ts
export function buildSelectOptions(candidates: Candidate[]) {
	const counts = new Map<string, number>();
	return candidates.map((candidate) => {
		const base = `${candidate.ref} — ${candidate.detail}`;
		const seen = (counts.get(base) ?? 0) + 1;
		counts.set(base, seen);
		return { label: seen === 1 ? base : `${base} (${seen})`, candidate };
	});
}
```

Map the returned label back to the candidate by the option array, not by
`indexOf` on the raw candidate label.

## 5. Persist the selection and the model name

Store three fields: `provider`, `modelId`, and `modelName`. The provider/model
pair is the stable key used for lookup. `modelName` is a display cache for
messages and status output, so the extension can show the name without a
registry read.

Rules:

- Never resolve a model by `modelName`. Names are not unique and change between
 catalog releases. Always resolve with `find(provider, modelId)`.
- On resolve, prefer the registry's current `model.name`; fall back to the
 stored `modelName` when the model is no longer in the registry. This keeps a
 persisted-but-unavailable model identifiable (qi regression `6949` shows it,
 it does not drop it).
- If the registry name differs from the stored one, overwrite the cache on the
 next successful resolve.

State shape:

```ts
interface SelectionState {
	version: 1;
	provider: string | null;
	modelId: string | null;
	modelName: string | null;
	selectedAt: string | null;
}
```

Use an extension-owned, versioned file, not a qi settings key:

```ts
import { join } from "node:path";
import { getAgentDir } from "@bramburn/qi-coding-agent";

const statePath = join(getAgentDir(), "extensions", "<your-extension>", "state.json");
```

Pattern that works:

- `version: 1`, `provider`, `modelId`, `modelName`, `selectedAt`.
- Read totally: missing, unreadable, malformed, unknown-version, or wrong-typed
 files all degrade to "no selection". Never throw.
- Write atomically: write a sibling temp file, then `renameSync` over the target.
- Provide a clear command or flag that removes the file.
- Resolve precedence explicitly and report it, e.g. in-session selection, then
 an env var, then persisted state, then the session model.

Resolve and refresh the name at use time:

```ts
function resolvePersisted(registry: ModelRegistry, state: SelectionState) {
	if (!state.provider || !state.modelId) return undefined;
	const model = registry.find(state.provider, state.modelId);
	if (!model) {
		// Keep the stored name so the UI can still identify the missing model.
		return { ref: `${state.provider}/${state.modelId}`, name: state.modelName };
	}
	if (model.name !== state.modelName) state.modelName = model.name; // refresh cache
	return { model, ref: `${model.provider}/${model.id}`, name: model.name };
}
```

## 6. Package rules

- `@bramburn/qi-coding-agent`, `@bramburn/qi-ai`, and `@bramburn/qi-tui` belong
 in `devDependencies`, not `dependencies`. The host aliases them at load time;
 adding them as runtime deps installs a second copy.
- Do not deep-import host internals such as
 `@bramburn/qi-coding-agent/dist/modes/interactive/model-search.js`. The loader
 alias map matches exact specifiers only; a subpath falls back to node
 resolution and fails.
- This is a qi extension. Never emit `pi`, `PI_*`, `~/.pi`, `.pi/`, or
 `@earendil-works/*`.

## 7. Tests to write

No network, no credentials. Stub the registry and the UI context.

- Pin the selector search text byte-for-byte.
- `openai/gpt-5` ranks above `openrouter/openai/gpt-5`.
- A slashed id is reachable by its bare id.
- Empty query returns the full list in default order.
- Repeated calls are deterministic.
- Typing resets the highlight to row 0 after moving it down (regression `7209`).
- Enter resolves exactly once; Escape resolves `undefined`.
- Rendered lines never exceed the requested width at 20/40/80/120.
- Drill-down reaches every candidate in at most two selections; paging
 terminates; cancel leaves persisted state untouched.
- Two candidates with identical labels stay individually selectable.
- Persisting writes `provider`, `modelId`, and `modelName`; a persisted model
 missing from the registry still reports the stored name instead of disappearing.
- Argument completions and the picker use the same filter and therefore rank
 identically.

## 8. Verify

```bash
bun install
bun run check     # biome + tsc
bun run test
```

If a real qi checkout is available, run its `check` and focused tests. Do not
claim interactive picker behavior was verified unless it actually was.