import sqlite3

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from docgen import nodes
from docgen.config import DOCGEN_DIR
from docgen.state import DocState


def fan_out(state: DocState):
    if not state.get("tasks"):
        return END
    return [Send("write_page", {"task": task}) for task in state["tasks"]]


def after_build(state: DocState):
    if not state.get("build_errors"):
        return "publish"
    if state.get("repair_round", 0) >= 2:
        return "halt"
    return "repair"


def build_graph(checkpointer=None):
    graph = StateGraph(DocState)
    graph.add_node("scan_changes", nodes.scan_changes)
    graph.add_node("plan_pages", nodes.plan_pages)
    graph.add_node("write_page", nodes.write_page)
    graph.add_node("assemble", nodes.assemble)
    graph.add_node("brand_check", nodes.brand_check)
    graph.add_node("build_validate", nodes.build_validate)
    graph.add_node("repair", nodes.repair)
    graph.add_node("publish", nodes.publish)
    graph.add_node("halt", nodes.halt)

    graph.add_edge(START, "scan_changes")
    graph.add_conditional_edges("scan_changes", lambda s: "plan_pages" if s.get("changed_files") else END)
    graph.add_conditional_edges("plan_pages", fan_out, ["write_page", END])
    graph.add_edge("write_page", "assemble")
    graph.add_edge("assemble", "brand_check")
    graph.add_edge("brand_check", "build_validate")
    graph.add_conditional_edges("build_validate", after_build, ["publish", "repair", "halt"])
    graph.add_edge("repair", "brand_check")
    graph.add_edge("publish", END)
    graph.add_edge("halt", END)
    return graph.compile(checkpointer=checkpointer)


def make_app():
    DOCGEN_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DOCGEN_DIR / "checkpoints.db"), check_same_thread=False)
    return build_graph(SqliteSaver(conn))


if __name__ == "__main__":
    # Keep this cheap: importing the module builds the graph but does not call
    # any model, so `python -m docgen.graph` doubles as a syntax/wiring check.
    make_app()
    print("graph OK")