import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";
import {
  buildMemoryGraph,
  GRAPH_FORMATS,
  inferGraphFormat,
  isGraphFormat,
  layoutGraph,
  renderGraph,
  type MemoryGraphSnapshot,
} from "../src/core/graph/index.ts";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
const context = { author: { type: "system" as const, id: "test" } };

function text(value: unknown): string {
  return String(value);
}

async function withGraphStore(
  callback: (store: MemoryStore, snapshot: MemoryGraphSnapshot) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-graph-"));
  const store = await MemoryStore.open({
    dbPath: path.join(root, "memory.sqlite"),
    projectRoot: root,
    projectId: "11111111-1111-4111-8111-111111111111",
    now: fixedNow,
  });
  try {
    const component = store.remember(
      {
        kind: "component",
        title: "Core & component <beta>",
        body: "Coordinates storage and </script><script>retrieval</script>.",
        scope: ["src/z", "src/a"],
        tags: ["zeta", "alpha"],
        citations: [{ type: "file", locator: "README.md" }],
      },
      context,
    ).node!;
    store.remember(
      {
        kind: "decision",
        title: "Use the core component",
        body: "The decision depends on the core component.",
        citations: [{ type: "file", locator: "README.md" }],
        links: [{ to: component.id, type: "depends_on" }],
      },
      context,
    );
    const oldGotcha = store.remember(
      {
        kind: "gotcha",
        title: "Old trap",
        body: "This claim is superseded.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      context,
    ).node!;
    store.remember(
      {
        kind: "gotcha",
        title: "New trap",
        body: "This claim replaces the old trap.",
        citations: [{ type: "file", locator: "README.md" }],
        supersedes: oldGotcha.id,
      },
      context,
    );
    const archived = store.remember(
      {
        kind: "fact",
        title: "Archived fact",
        body: "This claim is archived.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      context,
    ).node!;
    store.archive(archived.id, context, "test archive");

    const retiredSource = store.remember(
      {
        kind: "source",
        title: "Retired source",
        body: "Source endpoint.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      context,
    ).node!;
    const retiredTarget = store.remember(
      {
        kind: "source",
        title: "Retired target",
        body: "Target endpoint.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      context,
    ).node!;
    store.link(retiredSource.id, retiredTarget.id, "related_to", context);
    store.unlink(retiredSource.id, retiredTarget.id, "related_to", context);

    await callback(store, store.graphSnapshot({ includeRetired: true }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("graph model filters and canonicalizes nodes and edges", async () => {
  await withGraphStore(async (store, snapshot) => {
    const graph = buildMemoryGraph(snapshot);
    assert.equal(graph.schemaVersion, 1);
    assert.equal(graph.projectId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      [...graph.nodes.map((node) => node.id)].sort(),
    );
    assert.equal(graph.nodes.length, 7);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.edges.every((edge) => !edge.retiredAt), true);

    const component = graph.nodes.find((node) => node.kind === "component")!;
    assert.deepEqual(component.scope, ["src/a", "src/z"]);
    assert.deepEqual(component.tags, ["alpha", "zeta"]);

    const withRetired = buildMemoryGraph(snapshot, { includeRetired: true });
    assert.equal(withRetired.edges.length, 3);
    assert.equal(withRetired.edges.filter((edge) => edge.retiredAt).length, 1);

    const active = buildMemoryGraph(snapshot, { activeOnly: true });
    assert.equal(active.nodes.length, 5);
    assert.equal(
      active.nodes.some((node) => node.status === "superseded" || node.status === "archived"),
      false,
    );
    assert.equal(active.edges.length, 1);
    assert.equal(active.edges[0]?.type, "depends_on");

    assert.equal(isGraphFormat("html"), true);
    assert.equal(isGraphFormat("yaml"), false);
    assert.equal(inferGraphFormat("graph.graphml"), "graphml");
    assert.equal(inferGraphFormat("graph.dot"), "dot");
    assert.equal(inferGraphFormat("graph.gv"), "dot");
    assert.equal(inferGraphFormat("graph.json"), "json");
    assert.equal(inferGraphFormat("graph.htm"), "html");
    assert.equal(inferGraphFormat("GRAPH.HTML"), "html");
    assert.equal(inferGraphFormat("graph.yaml"), undefined);
    assert.equal(inferGraphFormat(undefined), undefined);

    const again = buildMemoryGraph(store.graphSnapshot({ includeRetired: true }));
    assert.deepEqual(again, graph);
  });
});

test("all graph formats are deterministic and escape embedded content", async () => {
  await withGraphStore(async (store) => {
    const graph = buildMemoryGraph(store.graphSnapshot({ includeRetired: true }), {
      includeRetired: true,
    });
    const again = buildMemoryGraph(store.graphSnapshot({ includeRetired: true }), {
      includeRetired: true,
    });
    assert.deepEqual(layoutGraph(graph), layoutGraph(again));

    for (const format of GRAPH_FORMATS) {
      assert.equal(renderGraph(graph, format), renderGraph(again, format), format);
    }

    const json = renderGraph(graph, "json");
    const parsed = JSON.parse(json);
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(
      parsed.nodes.map((node: { id: string }) => node.id),
      graph.nodes.map((node) => node.id),
    );
    assert.equal(json.endsWith("\n"), true);

    const graphml = renderGraph(graph, "graphml");
    assert.match(graphml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
    assert.match(graphml, /Core &amp; component &lt;beta&gt;/);
    assert.match(graphml, /&lt;\/script&gt;/);
    assert.match(graphml, /<node id="component\//);
    assert.match(graphml, /<edge id="e0"/);
    const keyIDs = [...graphml.matchAll(/<key id="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(keyIDs).size, keyIDs.length);

    const dot = renderGraph(graph, "dot");
    assert.match(dot, /^digraph goldfish \{/);
    assert.match(dot, /Core & component <beta>/);
    assert.match(dot, /\\n\(component\)/);
    assert.match(dot, /->/);

    const html = renderGraph(graph, "html");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
    assert.match(html, /id="goldfish-data"/);
    assert.match(html, /var DATA = JSON\.parse/);
    assert.doesNotMatch(html, /marker-end/);
    assert.match(html, /arrowhead = createSVG\("polygon"\)/);

    const dataMatch = /<script id="goldfish-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(dataMatch);
    assert.doesNotMatch(text(dataMatch![1]), /<\/script/i);
    const embedded = JSON.parse(dataMatch![1]!);
    assert.equal(embedded.graph.nodes.length, graph.nodes.length);
    assert.equal(Object.keys(embedded.layout).length, graph.nodes.length);

    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch);
    assert.doesNotThrow(() => new Function(scriptMatch![1]!));

    const layout = layoutGraph(graph);
    assert.deepEqual(layoutGraph(graph), layout);
    assert.equal(Object.keys(layout).length, graph.nodes.length);
    for (const position of Object.values(layout)) {
      assert.equal(Number.isFinite(position.x), true);
      assert.equal(Number.isFinite(position.y), true);
    }
  });
});

test("empty graph renders valid output in every format", () => {
  const graph = buildMemoryGraph({ nodes: [], edges: [] });
  assert.deepEqual(layoutGraph(graph), {});
  for (const format of GRAPH_FORMATS) {
    const output = renderGraph(graph, format);
    assert.equal(output.length > 0, true, format);
  }
  assert.match(renderGraph(graph, "graphml"), /<graph id="goldfish" edgedefault="directed">/);
  assert.match(renderGraph(graph, "html"), /id="graph"/);
});
