"""Preflight checks for the docgen LLM endpoint.

The endpoint is configurable, and the wrong server on the right port is a real
failure mode: a local reranker also answers OpenAI-compatible `/v1/models`, but
it cannot chat. Autodetecting and then "freeing" the port is what stopped an
unrelated reranker in an earlier session, so a mismatch is a hard, explanatory
stop here instead.
"""

import json
import urllib.error
import urllib.request

from docgen.config import LLM_BASE_URL, LLM_MODEL


def _fail(message: str) -> None:
    raise SystemExit(message)


def preflight() -> None:
    """Fail fast if the configured server is missing or is not a chat model."""
    url = LLM_BASE_URL.rstrip("/") + "/models"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            models = json.load(response)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        _fail(
            f"no docgen model server at {LLM_BASE_URL} ({exc}).\n"
            "Start the dedicated docgen llama-server on its own port (see README). "
            "Do NOT stop whatever currently owns this port."
        )

    # llama.cpp answers both the OpenAI shape ({"data": [...]}) and its own
    # native shape ({"models": [...]}); accept either so the diagnostics below
    # are what the user actually sees.
    entries = models.get("data") or models.get("models") or []
    ids = [entry.get("id") or entry.get("model") or entry.get("name") or "" for entry in entries]

    if LLM_MODEL not in ids:
        _fail(
            f"docgen server at {LLM_BASE_URL} does not serve '{LLM_MODEL}' (serves: {ids}).\n"
            "Start the dedicated docgen llama-server on its own port (see README), "
            "or point QI_DOCGEN_LLM_BASE_URL / QI_DOCGEN_LLM_MODEL at a server that does. "
            "Do NOT stop whatever currently owns this port."
        )

    for entry in entries:
        if (entry.get("id") or entry.get("model")) != LLM_MODEL:
            continue
        meta = entry.get("meta") or {}
        if meta.get("reranking"):
            _fail(
                f"endpoint {LLM_BASE_URL} serves a RERANKER ('{LLM_MODEL}'), not a chat model.\n"
                "Fix QI_DOCGEN_LLM_BASE_URL: the docgen chat server must run on its own port "
                "(8081 by default). Do NOT stop the reranker."
            )