import os
from pathlib import Path

from langchain_openai import ChatOpenAI

from docgen.state import PlanModel

REPO = Path(__file__).resolve().parents[3]
WEBSITE = REPO / "website"
DOCGEN_DIR = REPO / "tools" / "docgen" / ".docgen"
MANIFEST = DOCGEN_DIR / "manifest.json"

# llama.cpp's server exposes an OpenAI-compatible chat endpoint. The defaults
# match the README's llama-server invocation; the env vars exist so the eval
# harness can point at a server started on another port.
BASE_URL = os.environ.get("DOCGEN_BASE_URL", "http://127.0.0.1:8080/v1")
MODEL = os.environ.get("DOCGEN_MODEL", "doc-writer")
API_KEY = os.environ.get("DOCGEN_API_KEY", "local")

_common = {
    "base_url": BASE_URL,
    "api_key": API_KEY,
    "model": MODEL,
    "timeout": 900,
    # Qwen3.6 is a thinking model. With thinking enabled the server bills 5-10x
    # the output tokens for reasoning that LangChain then discards, so disable
    # it per request via the chat template. Verified against llama-server 0.7.0.
    "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
}

# Round 8 (L1): at temperature 0.2 the same prompt produced a clean page on one
# run and a page missing a required symbol / carrying a stray .md link on the
# next. Nightly runs need reproducibility, so the writer is greedy.
writer = ChatOpenAI(temperature=0, max_tokens=4096, **_common)
triage = ChatOpenAI(temperature=0, max_tokens=2000, **_common)

planner = triage.with_structured_output(PlanModel, method="json_schema")