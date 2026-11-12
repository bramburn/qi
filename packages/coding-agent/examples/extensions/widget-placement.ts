import type { ExtensionAPI } from "@bramburn/qi-coding-agent";

export default function widgetPlacementExtension(qi: ExtensionAPI) {
	qi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
