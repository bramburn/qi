import re
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage

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

WRITE_SYSTEM = f"""Write one Docusaurus MDX page for qi.

{BRAND_RULES}
Hard rules:
- Frontmatter MUST include id, title, sidebar_label.
- Real content only; no placeholders or TODOs.
- Relative links for internal pages; code fences tagged ts/bash/powershell/json/yaml.
- Explain as: problem -> concrete example -> solution. Direct technical prose, no filler.
- Document ONLY what the provided source shows; never invent APIs.
- Output the MDX file content only, no commentary, no outer code fence.
"""

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


def write(task: dict, context: str) -> list:
    return [
        SystemMessage(content=WRITE_SYSTEM),
        HumanMessage(
            content=f"Target page: {task['doc_path']} (kind: {task.get('kind', 'guide')})\n"
            f"Reason: {task.get('reason', '')}\n\nSource material:\n{context}"
        ),
    ]


def repair(page: dict, errors: str) -> list:
    return [
        SystemMessage(content=REPAIR_SYSTEM),
        HumanMessage(content=f"Page {page['doc_path']}:\n{page['content']}\n\nErrors:\n{errors}"),
    ]


def ensure_frontmatter(content: str, task: dict) -> str:
    content = content.strip()
    if content.startswith("```"):
        # Strip an accidental outer fence the model added around the page.
        content = re.sub(r"^```[a-zA-Z]*\n", "", content)
        content = re.sub(r"\n```$", "", content)
    if content.startswith("---"):
        return content + "\n"
    stem = Path(task["doc_path"]).stem
    title = stem.replace("-", " ").replace("_", " ").title()
    frontmatter = f"---\nid: {stem}\ntitle: {title}\nsidebar_label: {title}\n---\n\n"
    return frontmatter + content + "\n"


def pages_from_errors(errors: str, pages: dict) -> list[dict]:
    """Pages whose doc_path (or basename) appears in the error text.

    Falls back to every page when nothing matches: Docusaurus link errors often
    name the *target* of a broken link rather than the page that owns it.
    """
    hits = [page for path, page in pages.items() if path in errors or Path(path).name in errors]
    return hits or list(pages.values())