import os
from pathlib import Path

from langchain_openai import ChatOpenAI

from docgen.state import PlanModel

REPO = Path(__file__).resolve().parents[3]
WEBSITE = REPO / "website"
DOCGEN_DIR = REPO / "tools" / "docgen" / ".docgen"
MANIFEST = DOCGEN_DIR / "manifest.json"

# The docgen chat server has its OWN port. 8080 is reserved for the local
# reranker (qwen3-reranker-0.6b) and must never be assumed or reclaimed: an
# earlier session assumed 8080 and ended up stopping the reranker to "free" it.
LLM_BASE_URL = os.environ.get("QI_DOCGEN_LLM_BASE_URL", "http://127.0.0.1:8081/v1")
LLM_MODEL = os.environ.get("QI_DOCGEN_LLM_MODEL", "doc-writer")
LLM_API_KEY = os.environ.get("QI_DOCGEN_LLM_API_KEY", "local")

# L4 sectioned generation: one H2 section per LLM call, deterministic assembly.
# Set QI_DOCGEN_SECTIONED=0 to fall back to whole-page generation.
SECTIONED = os.environ.get("QI_DOCGEN_SECTIONED", "1") == "1"

_common = {
 "base_url": LLM_BASE_URL,
 "api_key": LLM_API_KEY,
 "model": LLM_MODEL,
 "timeout": 900,
 # Qwen3.6 is a thinking model. With thinking enabled the server bills 5-10x
 # the output tokens for reasoning that LangChain then discards, so disable
 # it per request via the chat template. Verified against llama-server 0.7.0.
 "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
}

# Per-section budget: a single H2 section never needs a whole page.
writer = ChatOpenAI(temperature=0, max_tokens=2500, **_common)

# The whole-page fallback (SECTIONED=0) does need a whole page. Round 2 found
# that 3000 tokens truncates a dense reference page mid-fence, so it keeps the
# larger budget it was tuned with.
page_writer = writer.bind(max_tokens=4096)

triage = ChatOpenAI(temperature=0, max_tokens=2000, **_common)

planner = triage.with_structured_output(PlanModel, method="json_schema")