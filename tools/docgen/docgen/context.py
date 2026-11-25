import re

from docgen.config import REPO

# A whole-file dump is useless once it exceeds the budget: the declarations at
# the end of the file are exactly the ones the model then omits. When a source
# is too large we keep the head and append an index of every exported
# declaration that fell past the cut.
EXPORT_LINE = re.compile(
    r"^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?"
    r"(?:interface|type|class|const|function|enum)\s+\w+"
)


def _export_index(text: str) -> list[str]:
    index = []
    for line in text.splitlines():
        if EXPORT_LINE.match(line):
            index.append(line.strip()[:160])
    return index


def source_slice(text: str, budget: int) -> str:
    if len(text) <= budget:
        return text
    head = text[:budget]
    index = _export_index(text[budget:])
    if not index:
        return head + "\n\n... [truncated]"
    listing = "\n".join(f"- {line}" for line in index)
    return head + "\n\n... [truncated; remaining exported declarations]\n" + listing


def read_sources(paths: list[str], budget: int = 24_000) -> str:
    chunks: list[str] = []
    remaining = budget
    for rel in paths:
        path = REPO / rel
        if not path.exists() or remaining <= 0:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        chunk = source_slice(text, remaining)
        chunks.append(f"<file path={rel}>\n{chunk}\n</file>")
        remaining -= min(len(chunk), remaining)
    return "\n".join(chunks)