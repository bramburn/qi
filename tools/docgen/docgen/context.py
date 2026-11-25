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

TYPE_HEADER = re.compile(
    r"^export\s+(?:interface|type|class)\s+(\w+)[^\n]*\{?\s*$"
)
MEMBER = re.compile(r"^\s{1,2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:?(]")


def member_index_for(rel: str) -> list[str]:
    """Field index for one repo-relative source, empty when it has no object types."""
    path = REPO / rel
    if not path.exists() or not rel.endswith((".ts", ".tsx")):
        return []
    return _member_index(path.read_text(encoding="utf-8", errors="replace"))


def _member_index(text: str, limit: int = 4000) -> list[str]:
    """`Interface -> field, field, ...` for every exported object type.

    A reference page has to name the fields callers pass, and a small model
    enumerates selectively: one round listed `temperature`, `maxTokens` and
    `transport` for `StreamOptions` and silently dropped `samplingParams`. An
    explicit field index removes the recall problem instead of asking the model
    to be more thorough.
    """
    lines = text.splitlines()
    entries: list[str] = []
    used = 0
    for number, line in enumerate(lines):
        header = TYPE_HEADER.match(line)
        if not header:
            continue
        depth = line.count("{") - line.count("}")
        fields: list[str] = []
        for body_line in lines[number + 1 :]:
            depth += body_line.count("{") - body_line.count("}")
            if depth <= 0:
                break
            if depth == 1:
                member = MEMBER.match(body_line)
                if member:
                    fields.append(member.group(1))
        if not fields:
            continue
        entry = f"- {header.group(1)}: {', '.join(fields)}"
        if used + len(entry) > limit:
            entries.append("- ... (field index truncated)")
            break
        entries.append(entry)
        used += len(entry)
    return entries


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
        # Field names are the part of a reference page the model drops first, and
        # they are cheap to state explicitly.
        fields = _member_index(text) if rel.endswith((".ts", ".tsx")) else []
        if fields:
            chunks.append(f"<field_index path={rel}>\n" + "\n".join(fields) + "\n</field_index>")
        remaining -= min(len(chunk), remaining)
    return "\n".join(chunks)