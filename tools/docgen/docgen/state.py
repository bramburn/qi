import operator
from typing import Annotated, TypedDict

from pydantic import BaseModel, Field


class DocTask(TypedDict, total=False):
    doc_path: str  # repo-relative, e.g. "website/docs/architecture/ai-package.mdx"
    kind: str  # reference | guide | tutorial | architecture
    source_paths: list[str]
    reason: str


class PageResult(TypedDict):
    doc_path: str
    content: str  # full MDX including frontmatter
    source_paths: list[str]


class DocState(TypedDict, total=False):
    # Inputs / flags.
    bootstrap: bool
    dry_run: bool

    # scan_changes -> plan_pages.
    changed_files: list[str]

    # plan_pages -> fan-out payload (each Send carries exactly one task).
    tasks: list[DocTask]
    task: DocTask

    # write_page fan-in. Each branch appends, so repair can also append a
    # corrected version of a page and latest_pages() keeps the last one.
    pages: Annotated[list[PageResult], operator.add]

    # Validation loop.
    brand_errors: str
    build_errors: str
    repair_round: int


class TaskModel(BaseModel):
    doc_path: str
    kind: str
    source_paths: list[str]
    reason: str = ""


class PlanModel(BaseModel):
    tasks: list[TaskModel] = Field(default_factory=list)


def latest_pages(state: DocState) -> dict[str, PageResult]:
    """Dedupe fan-out + repair appends: last write per doc_path wins."""
    out: dict[str, PageResult] = {}
    for page in state.get("pages", []):
        out[page["doc_path"]] = page
    return out