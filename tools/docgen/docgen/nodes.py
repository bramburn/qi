import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path

from docgen import prompts
from docgen.config import MANIFEST, REPO, WEBSITE, planner, triage, writer
from docgen.state import latest_pages

PI_PATTERN = re.compile(r"\bpi\.dev\b|@earendil-works|\bPI_[A-Z_]+\b|earendil-works/pi")

SOURCE_ROOTS = ("packages/", "specs/")
SOURCE_SUFFIXES = (".ts", ".md", ".feature", ".json")
SEED_DOCS = REPO / "packages" / "coding-agent" / "docs"


def _sha(rel: str) -> str:
    path = REPO / rel
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"pages": {}}


def _run(args: list[str], cwd: Path = REPO, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=check)


def _extract_json(text: str) -> dict:
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"no JSON object in model output: {text[:400]!r}")
        candidate = text[start : end + 1]
    return json.loads(candidate)


def scan_changes(state):
    if state.get("bootstrap"):
        seeds = sorted(
            str(path.relative_to(REPO)).replace("\\", "/") for path in SEED_DOCS.glob("*.md")
        )
        return {
            "changed_files": seeds,
            "repair_round": 0,
            "pages": [],
            "brand_errors": "",
            "build_errors": "",
        }

    manifest = _manifest()
    last = manifest.get("last_commit") or "HEAD~1"
    diff = _run(["git", "diff", "--name-only", f"{last}..HEAD"])
    if diff.returncode != 0:
        # Stale manifest (rebased / rewritten history): fall back to the last commit.
        diff = _run(["git", "diff", "--name-only", "HEAD~1..HEAD"])

    changed = [
        line
        for line in diff.stdout.splitlines()
        if line.startswith(SOURCE_ROOTS)
        and line.endswith(SOURCE_SUFFIXES)
        and "/test/" not in line
        and not line.endswith("CHANGELOG.md")
    ]
    return {
        "changed_files": changed,
        "repair_round": 0,
        "pages": [],
        "brand_errors": "",
        "build_errors": "",
    }


def plan_pages(state):
    manifest = _manifest()

    if state.get("bootstrap"):
        tasks = [
            {
                "doc_path": f"website/docs/{Path(source).stem}.mdx",
                "kind": "guide",
                "source_paths": [source],
                "reason": "bootstrap migration of an existing qi doc",
            }
            for source in state["changed_files"]
        ]
        return {"tasks": tasks[:10]}

    existing = {path: entry["source_paths"] for path, entry in manifest["pages"].items()}
    try:
        plan = planner.invoke(prompts.plan(state["changed_files"], existing))
        tasks = [task.model_dump() for task in plan.tasks]
    except Exception as exc:  # noqa: BLE001 - server may lack json_schema support
        print(f"[docgen] structured planning failed ({exc}); falling back to JSON text")
        response = triage.invoke(prompts.plan_json(state["changed_files"], existing))
        tasks = _extract_json(response.content).get("tasks", [])

    valid = [
        task
        for task in tasks
        if task.get("doc_path", "").startswith("website/docs/")
        and task.get("doc_path", "").endswith(".mdx")
        and any(
            (REPO / source).exists()
            and _sha(source) != manifest["pages"].get(task["doc_path"], {}).get("hashes", {}).get(source)
            for source in task.get("source_paths", [])
        )
    ]
    return {"tasks": valid[:5]}


def write_page(state):
    task = state["task"]
    chunks: list[str] = []
    budget = 24_000
    for source in task.get("source_paths", []):
        path = REPO / source
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        chunk = text[:budget]
        chunks.append(f"<file path={source}>\n{chunk}\n</file>")
        budget -= len(chunk)
        if budget <= 0:
            break

    response = writer.invoke(prompts.write(task, "\n".join(chunks)))
    content = prompts.ensure_frontmatter(response.content, task)
    return {
        "pages": [
            {
                "doc_path": task["doc_path"],
                "content": content,
                "source_paths": task.get("source_paths", []),
            }
        ]
    }


def assemble(state):
    for page in latest_pages(state).values():
        dest = REPO / page["doc_path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(page["content"], encoding="utf-8")
    return {}


def brand_check(state):
    violations = []
    for page in latest_pages(state).values():
        for number, line in enumerate(page["content"].splitlines(), 1):
            if PI_PATTERN.search(line):
                violations.append(f"{page['doc_path']}:{number}: brand violation: {line.strip()}")
    return {"brand_errors": "\n".join(violations)}


def build_validate(state):
    try:
        result = subprocess.run(
            "npm run build",
            cwd=WEBSITE,
            shell=True,
            capture_output=True,
            text=True,
            timeout=900,
        )
        build_errors = "" if result.returncode == 0 else (result.stdout + result.stderr)[-8000:]
    except subprocess.TimeoutExpired:
        build_errors = "npm run build timed out after 900s"

    combined = "\n".join(part for part in (state.get("brand_errors", ""), build_errors) if part)
    return {"build_errors": combined}


def repair(state):
    errors = state["build_errors"]
    failing = prompts.pages_from_errors(errors, latest_pages(state))
    fixed = []
    for page in failing:
        response = writer.invoke(prompts.repair(page, errors))
        task = {
            "doc_path": page["doc_path"],
            "kind": "repair",
            "reason": "repair",
            "source_paths": page["source_paths"],
        }
        content = prompts.ensure_frontmatter(response.content, task)
        (REPO / page["doc_path"]).write_text(content, encoding="utf-8")
        fixed.append({**page, "content": content})
    return {
        "pages": fixed,
        "repair_round": state.get("repair_round", 0) + 1,
        "build_errors": "",
    }


def publish(state):
    pages = latest_pages(state)
    manifest = _manifest()
    head = _run(["git", "rev-parse", "HEAD"]).stdout.strip()

    if state.get("dry_run"):
        print(f"[dry-run] {len(pages)} page(s) written and build passed; no git actions taken.")
        return {}

    branch = f"docs/auto-{datetime.datetime.now():%Y%m%d-%H%M}"
    paths = list(pages)
    steps = [
        ["git", "checkout", "-b", branch],
        ["git", "add", *paths],
        ["git", "commit", "-m", "docs: regenerate pages from source changes"],
        ["git", "push", "fork", branch],
    ]
    for args in steps:
        result = _run(args)
        if result.returncode != 0:
            raise RuntimeError(f"git step failed: {args}\n{result.stderr}")

    subprocess.run(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            "bramburn/qi",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            "docs: automated documentation refresh",
            "--body",
            "Generated by the local docgen agent. Review before merge.\n\n"
            "This PR was opened automatically by tools/docgen and is not merged automatically.",
        ],
        cwd=REPO,
        check=True,
    )

    for page in pages.values():
        manifest["pages"][page["doc_path"]] = {
            "source_paths": page["source_paths"],
            "hashes": {source: _sha(source) for source in page["source_paths"] if (REPO / source).exists()},
            "generated_at": head,
        }
    manifest["last_commit"] = head
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {}


def halt(state):
    print(
        "BUILD/BRAND STILL FAILING after repair rounds - files left for human review:\n"
        + state.get("build_errors", "")
    )
    return {}