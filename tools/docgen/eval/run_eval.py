"""Run the writer prompt against the golden tasks; apply deterministic gates; save outputs.

Usage (from tools/docgen, venv active):

    python eval/run_eval.py                       # all tasks, 1 repetition
    python eval/run_eval.py --task ref-ai-types --repeat 2
    python eval/run_eval.py --round 3             # writes to .docgen/eval-runs/round-3/

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
from docgen.config import DOCGEN_DIR, REPO, writer  # noqa: E402

TASKS = json.loads((Path(__file__).parent / "tasks.json").read_text(encoding="utf-8"))

PI_PATTERN = re.compile(r"\bpi\.dev\b|@earendil-works|\bPI_[A-Z_]+\b|earendil-works/pi")
PLACEHOLDER = re.compile(r"\bTODO\b|\bTBD\b|\bLorem ipsum\b|\[insert\b|<placeholder", re.I)
UPSTREAM_LINK = re.compile(r"github\.com/earendil-works|pi\.dev", re.I)
KNOWN_FENCES = {"ts", "tsx", "bash", "powershell", "json", "yaml", "toml", "diff", "md", "text", "gherkin"}


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

    for link in re.findall(r"\]\((\.{1,2}/[^)#]+\.mdx?)\)", content):
        target = (REPO / task["doc_path"]).parent / link
        if not target.resolve().exists():
            fails.append(f"G-link: relative link {link!r} does not resolve")

    if len(content) < 600:
        fails.append("G-length: suspiciously short page (<600 chars)")
    return fails


def build_context(task: dict) -> str:
    chunks: list[str] = []
    budget = 24_000
    for source in task["source_paths"]:
        path = REPO / source
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")[:budget]
        chunks.append(f"<file path={source}>\n{text}\n</file>")
        budget -= len(text)
        if budget <= 0:
            break
    return "\n".join(chunks)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--round", type=int, default=0)
    args = parser.parse_args()

    outdir = DOCGEN_DIR / "eval-runs" / f"round-{args.round}"
    outdir.mkdir(parents=True, exist_ok=True)

    tasks = [task for task in TASKS if not args.task or task["id"] == args.task]
    report = []
    for task in tasks:
        for repetition in range(args.repeat):
            started = time.time()
            response = writer.invoke(prompts.write(task, build_context(task)))
            content = prompts.ensure_frontmatter(response.content, task)
            fails = gates(content, task)
            name = f"{task['id']}.run{repetition}.mdx"
            (outdir / name).write_text(content, encoding="utf-8")
            report.append(
                {
                    "task": task["id"],
                    "run": repetition,
                    "file": name,
                    "seconds": round(time.time() - started, 1),
                    "chars": len(content),
                    "gate_failures": fails,
                }
            )
            status = "PASS" if not fails else "FAIL"
            print(f"{status} {name} ({len(fails)} gate failures)")

    (outdir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    total = sum(len(entry["gate_failures"]) for entry in report)
    print(f"\n{len(report)} generations, {total} total gate failures. Outputs: {outdir}")


if __name__ == "__main__":
    main()