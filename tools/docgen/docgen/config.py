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
}

writer = ChatOpenAI(temperature=0.2, max_tokens=6000, **_common)
triage = ChatOpenAI(temperature=0, max_tokens=2000, **_common)

planner = triage.with_structured_output(PlanModel, method="json_schema")