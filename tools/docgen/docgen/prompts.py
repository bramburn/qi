import re
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage

from docgen.config import REPO

LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")

BRAND_RULES = """Identity rules (non-negotiable):
- The product is "qi", a standalone fork. Never call it "pi" or the pi symbol.
- Packages are @bramburn/qi-*; env vars are QI_*; config dir is ~/.qi/agent.
- The CLI binary is `qi`. Version output is `qi <version> [bramburn]`.
- Never link to earendil-works/pi or pi.dev - upstream is severed (ADR-0002).
- If a source file still contains legacy branding, document the qi equivalent; do not copy the legacy name into the page.
"""

PLAN_SYSTEM = f"""You maintain the Docusaurus docs for qi, a local-first AI coding agent.

{BRAND_RULES}
Given changed source files and the existing page->sources map, output tasks that map changes to doc pages.
Rules:
- Architecture pages go under website/docs/architecture/, fork pages under website/docs/fork/.
- Prefer UPDATING an existing page over creating a new one.
- Max 5 tasks per run. Only include pages genuinely affected by the changes.
- doc_path must end in .mdx and live under website/docs/.
"""

PLAN_JSON_SYSTEM = (
    PLAN_SYSTEM
    + '\nOutput ONLY a raw JSON object of the form {"tasks": [{"doc_path": "...", "kind": "...", '
    '"source_paths": ["..."], "reason": "..."}]}. No prose, no code fences.\n'
)

WRITE_EXAMPLE = """
<example_page>
---
id: retry-budget
title: Retry Budget
sidebar_label: Retry Budget
---

## Problem

A tool call that fails once is usually a transient failure, but retrying it forever
hides the real error and burns tokens. Callers need a bounded policy they can reason
about.

## Configure the budget

The budget is a single integer in the tool definition:

```ts
const tool = defineTool({
  name: "fetch-page",
  retryBudget: 2,
});
```

Each entry in `retryBudget` is one additional attempt after the first failure.

## Observe the result

When the budget is exhausted the tool returns the last error instead of retrying:

```bash
fetch-page https://example.com
# attempt 1 failed: timeout
# attempt 2 failed: timeout
# error: retry budget exhausted after 2 attempts
```

The same limit applies to every caller, so the session log stays readable.

## Notes

- The budget is per call, not per session.
- A tool without `retryBudget` never retries.
</example_page>
"""

WRITE_SYSTEM = f"""Write one Docusaurus MDX page for qi.

{BRAND_RULES}
Hard rules:
- Frontmatter MUST include id, title, sidebar_label.
- Real content only; no placeholders or TODOs.
- Use only `ts` and `bash` code fences, always tagged, always closed.
- Link only to pages that already exist under website/docs/. If you are not sure the target page exists, name it in backticks instead of linking to it. Never copy .md links out of a source file.
- Explain as: problem -> concrete example -> solution. Direct technical prose, no filler.
- Document ONLY what the provided source shows; never invent APIs.
- Every identifier, package name, CLI command, flag, config key and file path you write must appear verbatim in the source material. If the source has no runnable example, build the example only from symbols defined in it, or leave the code block out.
- Do not invent an interface or type definition to illustrate a format. Quote the format the source describes, or describe it in prose.
- Output the MDX file content only, no commentary, no outer code fence.

Format model (structure, tone and formatting only - never reuse its names, commands or values):
{WRITE_EXAMPLE}"""

REPAIR_SYSTEM = f"""Fix the given MDX page for qi so the Docusaurus build passes.

{BRAND_RULES}
You are given the current page and the build/brand errors. Return the FULL corrected MDX file content only.
Change as little as possible.
"""


def plan(changed: list[str], existing: dict) -> list:
    return [
        SystemMessage(content=PLAN_SYSTEM),
        HumanMessage(
            content="Changed files:\n"
            + "\n".join(changed)
            + "\n\nExisting page -> sources map:\n"
            + str(existing)
        ),
    ]


def plan_json(changed: list[str], existing: dict) -> list:
    """Fallback for servers without structured-output / json_schema support."""
    return [
        SystemMessage(content=PLAN_JSON_SYSTEM),
        HumanMessage(
            content="Changed files:\n"
            + "\n".join(changed)
            + "\n\nExisting page -> sources map:\n"
            + str(existing)
        ),
    ]


SECTION_TEMPLATES = {
    "reference": ["Overview", "API surface", "Example", "Notes"],
    "guide": ["When to use this", "Steps", "Verify"],
    "tutorial": ["Prerequisites", "Steps", "Verify"],
    "architecture": ["Problem", "Design", "Behaviour and error paths", "Consequences"],
}


def skeleton(kind: str) -> str:
    headings = SECTION_TEMPLATES.get(kind, SECTION_TEMPLATES["guide"])
    return "\n".join(f"## {heading}" for heading in headings)


def write(task: dict, context: str) -> list:
    return [
        SystemMessage(content=WRITE_SYSTEM),
        HumanMessage(
            content=f"Target page: {task['doc_path']} (kind: {task.get('kind', 'guide')})\n"
            f"Reason: {task.get('reason', '')}\n\n"
            "The frontmatter is already written. Output the page body only, starting at the first heading.\n\n"
            "Use exactly these sections, in this order, and add nothing before, between or after them.\n"
            "Do not add a 'Next steps', 'See also' or 'Related' section.\n"
            "Every section needs real content: at least two short paragraphs, a table, or a code block.\n"
            "In an API surface section, list every exported type, interface and function from the source, one bullet each, "
            "naming the fields that matter for callers (options and parameters included).\n"
            "<skeleton>\n"
            f"{skeleton(task.get('kind', 'guide'))}\n"
            "</skeleton>\n\n"
            f"Source material:\n{context}"
        ),
    ]


def repair(page: dict, errors: str) -> list:
    return [
        SystemMessage(content=REPAIR_SYSTEM),
        HumanMessage(content=f"Page {page['doc_path']}:\n{page['content']}\n\nErrors:\n{errors}"),
    ]


def sanitize_links(content: str, doc_path: str) -> str:
    """Drop relative .md/.mdx links whose target does not exist on disk.

    The model mirrors markdown links out of the source it is given (`providers.md`),
    but the generated site only contains `.mdx` pages and `onBrokenLinks: 'throw'`
    turns any such link into a build failure. No prompt wording stopped this, so a
    link that cannot resolve is unwrapped to its text deterministically instead of
    spending a repair round on it.
    """
    base = (REPO / doc_path).parent

    def repl(match: re.Match) -> str:
        text, target = match.group(1), match.group(2)
        if "://" in target or target.startswith(("/", "#", "mailto:")):
            return match.group(0)
        path_part = target.split("#", 1)[0]
        if not re.search(r"\.mdx?$", path_part):
            return match.group(0)
        if (base / path_part).resolve().exists():
            return match.group(0)
        return text

    return LINK.sub(repl, content)


ACRONYMS = {"ai": "AI", "tui": "TUI", "sdk": "SDK", "rpc": "RPC", "cli": "CLI", "json": "JSON", "api": "API"}


def _title_from_stem(stem: str) -> str:
    words = stem.replace("-", " ").replace("_", " ").split()
    return " ".join(ACRONYMS.get(word.lower(), word.capitalize()) for word in words)


def ensure_frontmatter(content: str, task: dict) -> str:
    content = content.strip()
    if content.startswith("```"):
        # Strip an accidental outer fence the model added around the page.
        content = re.sub(r"^```[a-zA-Z]*\n", "", content)
        content = re.sub(r"\n```$", "", content)
    content = sanitize_links(content, task["doc_path"])
    if content.startswith("---"):
        return content + "\n"
    stem = Path(task["doc_path"]).stem
    title = _title_from_stem(stem)
    frontmatter = f"---\nid: {stem}\ntitle: {title}\nsidebar_label: {title}\n---\n\n"
    return frontmatter + content + "\n"


def pages_from_errors(errors: str, pages: dict) -> list[dict]:
    """Pages whose doc_path (or basename) appears in the error text.

    Falls back to every page when nothing matches: Docusaurus link errors often
    name the *target* of a broken link rather than the page that owns it.
    """
    hits = [page for path, page in pages.items() if path in errors or Path(path).name in errors]
    return hits or list(pages.values())