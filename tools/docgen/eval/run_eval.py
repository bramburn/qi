"""Run the writer prompt against the golden tasks; apply deterministic gates; save outputs.

Usage (from tools/docgen, venv active):

    python eval/run_eval.py                          # all tasks, 1 repetition
    python eval/run_eval.py --task ref-ai-types --repeat 2
    python eval/run_eval.py --round 3                # writes to .docgen/eval-runs/round-3/
    python eval/run_eval.py --score-only .docgen/eval-runs/round-3   # gates only, no model calls

Quality judging is done by the supervising agent reading the saved .mdx files.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docgen import prompts  # noqa: E402
from docgen.config import DOCGEN_DIR, LLM_BASE_URL, REPO, SECTIONED  # noqa: E402
from docgen.context import read_sources  # noqa: E402
from docgen.nodes import write_page  # noqa: E402
from docgen.server import preflight  # noqa: E402
from docgen.state import latest_pages  # noqa: E402

TASKS = json.loads((Path(__file__).parent / "tasks.json").read_text(encoding="utf-8"))

PI_PATTERN = re.compile(r"\bpi\.dev\b|@earendil-works|\bPI_[A-Z_]+\b|earendil-works/pi")
PLACEHOLDER = re.compile(r"\bTODO\b|\bTBD\b|\bLorem ipsum\b|\[insert\b|<placeholder", re.I)
UPSTREAM_LINK = re.compile(r"github\.com/earendil-works|pi\.dev", re.I)
RELATIVE_LINK = re.compile(r"\]\((\.{0,2}/?[^)\s#]*\.mdx?)(#[^)\s]*)?\)")
KNOWN_FENCES = {
    "ts",
    "tsx",
    "typescript",
    "js",
    "javascript",
    "bash",
    "sh",
    "powershell",
    "ps1",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "diff",
    "md",
    "markdown",
    "mdx",
    "text",
    "console",
    "gherkin",
}

BLANK_FENCE = re.compile(r"```[a-zA-Z0-9]*\n(.*?)```", re.S)
# Only code fences are checked for invented names. Prose fences (md, text) hold
# English, and flagging their capitalised words would train readers of this gate
# to ignore it.
CODE_FENCE = re.compile(r"```(?:ts|tsx|typescript|js|javascript|json)\n(.*?)```", re.S)
# API-shaped backticked identifiers: dotted/member access or bracket indexing.
MEMBER_IDENT = re.compile(r"`([A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])+)`")
# A quoted literal inside a bracket index is an API name in its own right:
# `ApiOptionsMap["custom-api"]` is only valid if "custom-api" is a known Api.
BRACKET_LITERAL = re.compile(r"\[\s*['\"]([^'\"]+)['\"]\s*\]")
CAMEL_IDENT = re.compile(r"`([A-Z][A-Za-z0-9]{3,})`")
# Identifiers inside code fences: compound names are the JSON keys and API fields
# a model invents ("defaultRevision", "lastReviewed").
FENCED_IDENT = re.compile(r"\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*){1,})\b")
FENCED_CAMEL = re.compile(r"\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b")
# A name the example defines itself is the example's own symbol, not an API claim.
# `interface`/`class`/`enum` are deliberately NOT exempt: inventing a type shape is
# exactly the Faithfulness failure this gate exists for.
LOCAL_VALUE_DEF = re.compile(r"\b(?:const|let|var|type|function)\s+([A-Za-z_$][\w$]*)")

# Narrow, commented allowlist. Add an entry only after checking the source
# yourself and confirming the name is a qi convention rather than a model
# invention; never widen this into a blanket exemption.
IDENT_ALLOWLIST = {
    "typescript",  # fence tags are not identifiers
    "javascript",
    "powershell",
    "githubusercontent",
    "PATH",  # real OS variables, not qi API surface
    "HOME",
}


def gates(content: str, task: dict) -> list[str]:
    """Cheap mechanical checks. Returns failure strings (empty list = pass)."""
    fails: list[str] = []
    if not content.startswith("---"):
        fails.append("G-frontmatter: missing frontmatter block")
    else:
        frontmatter = content.split("---", 2)[1]
        for key in ("id:", "title:", "sidebar_label:"):
            if key not in frontmatter:
                fails.append(f"G-frontmatter: missing {key}")

    if PI_PATTERN.search(content):
        fails.append("G-brand: legacy pi branding present")
    if UPSTREAM_LINK.search(content):
        fails.append("G-brand: upstream link present")
    if PLACEHOLDER.search(content):
        fails.append("G-placeholder: placeholder text present")
    if content.strip().startswith("```"):
        fails.append("G-fence: whole page wrapped in an outer code fence")

    for fence in re.findall(r"^```(\S*)", content, re.M):
        if fence and fence not in KNOWN_FENCES:
            fails.append(f"G-fence: unknown language tag {fence!r}")
    if content.count("```") % 2 != 0:
        fails.append("G-fence: unbalanced code fences")

    for symbol in task.get("must_mention", []):
        if symbol not in content:
            fails.append(f"G-coverage: required symbol {symbol!r} absent")

    # Relative links must resolve to a file that exists on disk. Docusaurus with
    # onBrokenLinks: 'throw' fails the build otherwise, so a .md link to a .mdx
    # page is a real failure even though it "looks" right.
    for link, _anchor in RELATIVE_LINK.findall(content):
        if "://" in link or link.startswith("/"):
            continue
        target = (REPO / task["doc_path"]).parent / link
        if not target.resolve().exists():
            fails.append(f"G-link: relative link {link!r} does not resolve")

    if len(content) < 600:
        fails.append("G-length: suspiciously short page (<600 chars)")
    return fails


def structural_gates(content: str, task: dict, source_text: str) -> list[str]:
    """Mechanical anti-hallucination checks over the generated page.

    These are the two failure classes that survived prompt tuning: an invented
    JSON shape, and an invented member of a real API. Neither is caught by prose
    review at scale, and neither is caught by the build, so they are checked here.
    """
    fails: list[str] = []

    # G-json: every json fence must parse.
    for block in re.findall(r"```json\n(.*?)```", content, re.S):
        try:
            json.loads(block)
        except ValueError as exc:
            fails.append(f"G-json: invalid JSON fence: {exc}")

    # G-ident: API-shaped backticked identifiers must exist verbatim in the
    # sources. Plain prose words and CLI flags are exempt.
    for ident in MEMBER_IDENT.findall(content):
        root = re.split(r"[.[]", ident)[0]
        if ident not in source_text and root not in source_text:
            fails.append(f"G-ident: identifier {ident!r} not found in sources")
            continue
        # The root existing does not make the whole expression real.
        for literal in BRACKET_LITERAL.findall(ident):
            if literal not in source_text:
                fails.append(f"G-ident: indexed name {literal!r} not found in sources")

    for ident in CAMEL_IDENT.findall(content):
        if ident in IDENT_ALLOWLIST:
            continue
        if ident not in source_text:
            fails.append(f"G-ident: symbol {ident!r} not found in sources")

    # Fenced code: invented JSON keys, option names and type members live here and
    # are almost never written in backticks. Single lowercase words are exempt so
    # ordinary code ("const", "return", "items") does not trip the gate.
    for block in CODE_FENCE.findall(content):
        local = set(LOCAL_VALUE_DEF.findall(block))
        for ident in set(FENCED_IDENT.findall(block)) | set(FENCED_CAMEL.findall(block)):
            if ident in local or ident in IDENT_ALLOWLIST or ident in source_text:
                continue
            fails.append(f"G-ident: fenced name {ident!r} not found in sources")
        # `ApiOptionsMap["custom-api"]` names an API through a string literal, so
        # the lookup is only real if that literal is a known value.
        for literal in BRACKET_LITERAL.findall(block):
            if literal in IDENT_ALLOWLIST or literal in source_text:
                continue
            fails.append(f"G-ident: indexed name {literal!r} not found in sources")

    return fails


def build_context(task: dict) -> str:
    # Same helper the pipeline uses, so tuning measures production behaviour.
    return read_sources(task["source_paths"])


def generate(task: dict) -> str:
    """Run the production writer for one task and return the assembled page."""
    state = {"task": task, "pages": []}
    return latest_pages({**state, **write_page(state)})[task["doc_path"]]["content"]


def score(saved: Path, by_id: dict) -> list[str]:
    """Re-run every gate over already-generated pages (no model calls)."""
    failures: list[str] = []
    for path in sorted(saved.glob("*.mdx")):
        task = by_id.get(path.stem.split(".run")[0])
        if task is None:
            failures.append(f"{path.name}: no task matches this file")
            continue
        content = path.read_text(encoding="utf-8")
        found = gates(content, task) + structural_gates(content, task, build_context(task))
        failures.extend(f"{path.name}: {failure}" for failure in found)
        print(f"{'PASS' if not found else 'FAIL'} {path.name} ({len(found)} gate failures)")
        for failure in found:
            print(f"    {failure}")
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--round", type=int, default=0)
    parser.add_argument(
        "--score-only",
        metavar="DIR",
        help="re-run the gates over an existing round directory, no model calls",
    )
    args = parser.parse_args()

    if args.score_only:
        failures = score(Path(args.score_only), {task["id"]: task for task in TASKS})
        print(f"\n{len(failures)} gate failures in {args.score_only}")
        raise SystemExit(1 if failures else 0)

    preflight()

    outdir = DOCGEN_DIR / "eval-runs" / f"round-{args.round}"
    outdir.mkdir(parents=True, exist_ok=True)

    tasks = [task for task in TASKS if not args.task or task["id"] == args.task]
    report = []
    for task in tasks:
        for repetition in range(args.repeat):
            started = time.time()
            content = generate(task)
            fails = gates(content, task) + structural_gates(content, task, build_context(task))
            name = f"{task['id']}.run{repetition}.mdx"
            (outdir / name).write_text(content, encoding="utf-8")
            report.append(
                {
                    "task": task["id"],
                    "run": repetition,
                    "file": name,
                    "seconds": round(time.time() - started, 1),
                    "chars": len(content),
                    "sectioned": SECTIONED,
                    "base_url": LLM_BASE_URL,
                    "gate_failures": fails,
                }
            )
            status = "PASS" if not fails else "FAIL"
            print(f"{status} {name} ({len(fails)} gate failures)")
            for failure in fails:
                print(f"    {failure}")

    (outdir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    total = sum(len(entry["gate_failures"]) for entry in report)
    print(
        f"\n{len(report)} generations, {total} total gate failures. "
        f"sectioned={SECTIONED} base_url={LLM_BASE_URL}\nOutputs: {outdir}"
    )


if __name__ == "__main__":
    main()