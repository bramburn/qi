import argparse
import datetime

from docgen.graph import build_graph, make_app


def main():
    parser = argparse.ArgumentParser(description="qi documentation generator")
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="migrate packages/coding-agent/docs/*.md into website/docs/",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="write pages and build, but take no git/PR actions",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="compile the graph and exit (no LLM calls, no writes)",
    )
    args = parser.parse_args()

    if args.check:
        graph = build_graph().get_graph()
        print("graph OK:", sorted(graph.nodes))
        return

    app = make_app()
    thread = f"docgen-{datetime.datetime.now():%Y%m%d%H%M%S}"
    app.invoke(
        {
            "bootstrap": args.bootstrap,
            "dry_run": args.dry_run,
            "pages": [],
            "repair_round": 0,
            "brand_errors": "",
            "build_errors": "",
        },
        config={"configurable": {"thread_id": thread}},
    )


if __name__ == "__main__":
    main()