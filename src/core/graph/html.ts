import { EDGE_TYPES, NODE_KINDS, NODE_STATUSES } from "../types.ts";
import {
  GRAPH_VIEW_HEIGHT,
  GRAPH_VIEW_WIDTH,
  layoutGraph,
} from "./layout.ts";
import { EDGE_COLORS, KIND_COLORS, STATUS_OPACITY, STATUS_STROKES } from "./style.ts";
import type { MemoryGraph } from "./types.ts";

const EXPLORER_CSS = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --panel: #ffffff;
  --text: #0f172a;
  --muted: #64748b;
  --border: #e2e8f0;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: .8rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
h1 { margin: 0; font-size: 1rem; }
.stats { margin: .15rem 0 0; color: var(--muted); font-size: .78rem; }
.grow { flex: 1; }
.search { display: flex; align-items: center; gap: .4rem; color: var(--muted); font-size: .78rem; }
.search input {
  width: 16rem;
  max-width: 50vw;
  padding: .4rem .55rem;
  border: 1px solid var(--border);
  border-radius: .45rem;
  background: #fff;
  color: var(--text);
  font: inherit;
}
button {
  border: 1px solid var(--border);
  border-radius: .45rem;
  background: #fff;
  color: var(--text);
  padding: .4rem .65rem;
  font: inherit;
  cursor: pointer;
}
button:hover { background: var(--bg); }
main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  flex: 1;
  min-height: 0;
}
.canvas {
  position: relative;
  min-height: 0;
  background: radial-gradient(circle at 50% 45%, #ffffff 0, #f8fafc 62%);
}
svg#graph { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
svg#graph.dragging { cursor: grabbing; }
aside {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: auto;
  border-left: 1px solid var(--border);
  background: var(--panel);
  padding: 1rem;
}
section h2 {
  margin: 0 0 .5rem;
  color: var(--muted);
  font-size: .72rem;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.filters { display: grid; gap: .45rem; }
.filter-group { border: 1px solid var(--border); border-radius: .5rem; padding: .45rem .55rem; }
.filter-group summary { cursor: pointer; color: var(--muted); font-size: .78rem; }
.filter-row { display: flex; align-items: center; gap: .4rem; padding: .12rem 0; font-size: .78rem; }
.filter-row input { margin: 0; }
.swatch { display: inline-block; width: .7rem; height: .7rem; border-radius: 999px; flex: 0 0 auto; }
.details h3 { margin: 0 0 .3rem; font-size: 1rem; }
.meta { color: var(--muted); font-size: .75rem; line-height: 1.55; }
.body { margin: .7rem 0; white-space: pre-wrap; font-size: .84rem; line-height: 1.55; }
.chips { display: flex; flex-wrap: wrap; gap: .25rem; margin: .35rem 0; }
.chip { display: inline-block; border-radius: 999px; background: #f1f5f9; color: #334155; padding: .1rem .45rem; font-size: .72rem; }
.links { display: grid; gap: .25rem; margin: .4rem 0 0; padding: 0; list-style: none; }
.links button { padding: .3rem .45rem; text-align: left; font-size: .76rem; }
.muted { color: var(--muted); font-size: .8rem; }
.legend {
  position: absolute;
  left: .75rem;
  bottom: .75rem;
  max-width: 22rem;
  padding: .55rem .7rem;
  border: 1px solid var(--border);
  border-radius: .6rem;
  background: rgba(255, 255, 255, .94);
  color: var(--muted);
  font-size: .72rem;
}
.legend-item { display: flex; align-items: center; gap: .4rem; margin: .2rem 0; }
.node circle { cursor: pointer; stroke-width: 1.5; }
.node text {
  fill: #1f2937;
  stroke: #fff;
  stroke-width: 3px;
  stroke-linejoin: round;
  paint-order: stroke;
  pointer-events: none;
  font-size: 11px;
  text-anchor: middle;
}
.node.selected circle { stroke-width: 3; }
.node.neighbor circle { stroke-width: 2.5; }
.node.dim { opacity: .12; }
.edge { opacity: .55; }
.edge.active { opacity: 1; }
.edge.active line { stroke-width: 2; }
.edge.dim { opacity: .06; }
@media (max-width: 900px) {
  main { grid-template-columns: 1fr; grid-template-rows: minmax(20rem, 1fr) auto; }
  aside { max-height: 24rem; border-top: 1px solid var(--border); border-left: 0; }
}
`;

const EXPLORER_JS = String.raw`
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var DATA = JSON.parse(document.getElementById("goldfish-data").textContent);
  var graph = DATA.graph;
  var layout = DATA.layout;
  var style = DATA.style;
  var viewWidth = DATA.view.width;
  var viewHeight = DATA.view.height;

  var svg = document.getElementById("graph");
  var stats = document.getElementById("stats");
  var search = document.getElementById("search");
  var resetButton = document.getElementById("reset");
  var details = document.getElementById("details");
  var legend = document.getElementById("legend");

  var nodeByID = {};
  var nodeElements = {};
  var edgeElements = [];
  var neighbors = {};
  var selected = null;
  var visibleNodeIDs = {};

  graph.nodes.forEach(function (node) {
    nodeByID[node.id] = node;
    neighbors[node.id] = {};
  });
  graph.edges.forEach(function (edge) {
    if (neighbors[edge.source]) neighbors[edge.source][edge.target] = true;
    if (neighbors[edge.target]) neighbors[edge.target][edge.source] = true;
  });

  function createSVG(tag) {
    return document.createElementNS(NS, tag);
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function addText(parent, tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function truncate(value, max) {
    var text = String(value || "");
    return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
  }

  function matchesQuery(node, query) {
    if (!query) return true;
    var haystack = (node.id + "\n" + node.title + "\n" + node.body).toLowerCase();
    return haystack.indexOf(query) >= 0;
  }

  function arrowheadPoints(source, target) {
    var dx = target.x - source.x;
    var dy = target.y - source.y;
    var angle = Math.atan2(dy, dx);
    var tipX = target.x - Math.cos(angle) * 12;
    var tipY = target.y - Math.sin(angle) * 12;
    var baseX = tipX - Math.cos(angle) * 9;
    var baseY = tipY - Math.sin(angle) * 9;
    var perpX = -Math.sin(angle) * 4.5;
    var perpY = Math.cos(angle) * 4.5;
    return (
      tipX +
      "," +
      tipY +
      " " +
      (baseX + perpX) +
      "," +
      (baseY + perpY) +
      " " +
      (baseX - perpX) +
      "," +
      (baseY - perpY)
    );
  }

  var view = { x: 0, y: 0, w: viewWidth, h: viewHeight };
  function applyView() {
    svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h);
  }
  function resetView() {
    view = { x: 0, y: 0, w: viewWidth, h: viewHeight };
    applyView();
  }

  var edgeLayer = createSVG("g");
  var nodeLayer = createSVG("g");
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  graph.edges.forEach(function (edge) {
    var source = layout[edge.source];
    var target = layout[edge.target];
    if (!source || !target) return;
    var color = style.edgeColors[edge.type] || "#94a3b8";
    var group = createSVG("g");
    group.setAttribute("class", "edge");
    group.setAttribute("data-type", edge.type);

    var line = createSVG("line");
    line.setAttribute("x1", String(source.x));
    line.setAttribute("y1", String(source.y));
    line.setAttribute("x2", String(target.x));
    line.setAttribute("y2", String(target.y));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", String(1 + Math.min(2, edge.weight || 1)));
    line.setAttribute("stroke-linecap", "round");
    if (edge.retiredAt) line.setAttribute("stroke-dasharray", "4 4");
    group.appendChild(line);

    var arrowhead = createSVG("polygon");
    arrowhead.setAttribute("points", arrowheadPoints(source, target));
    arrowhead.setAttribute("fill", color);
    group.appendChild(arrowhead);

    var edgeTitle = createSVG("title");
    edgeTitle.textContent = edge.type;
    group.appendChild(edgeTitle);

    edgeLayer.appendChild(group);
    edgeElements.push({ element: group, edge: edge });
  });

  graph.nodes.forEach(function (node) {
    var position = layout[node.id] || { x: viewWidth / 2, y: viewHeight / 2 };
    var group = createSVG("g");
    group.setAttribute("class", "node");
    group.setAttribute("data-id", node.id);
    group.setAttribute("transform", "translate(" + position.x + " " + position.y + ")");
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", node.title);

    var nodeTitle = createSVG("title");
    nodeTitle.textContent = node.title + "\n" + node.kind + " \u00b7 " + node.status;
    group.appendChild(nodeTitle);

    var circle = createSVG("circle");
    circle.setAttribute("r", "10");
    circle.setAttribute("fill", style.kindColors[node.kind] || "#64748b");
    circle.setAttribute("stroke", style.statusStrokes[node.status] || "#ffffff");
    circle.setAttribute("opacity", String(style.statusOpacity[node.status] || 1));
    group.appendChild(circle);

    var label = createSVG("text");
    label.setAttribute("y", "24");
    label.setAttribute("opacity", String(style.statusOpacity[node.status] || 1));
    label.textContent = truncate(node.title, 24);
    group.appendChild(label);

    group.addEventListener("click", function (event) {
      event.stopPropagation();
      selectNode(node.id);
    });
    group.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(node.id);
      }
    });

    nodeLayer.appendChild(group);
    nodeElements[node.id] = group;
  });

  function buildFilterGroup(title, values, colors) {
    var group = document.createElement("details");
    group.className = "filter-group";
    group.open = true;
    var summary = document.createElement("summary");
    summary.textContent = title;
    group.appendChild(summary);
    var state = {};
    values.forEach(function (value) {
      var row = document.createElement("label");
      row.className = "filter-row";
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.value = value;
      checkbox.addEventListener("change", function () {
        state[value] = checkbox.checked;
        applyFilters();
      });
      state[value] = true;
      row.appendChild(checkbox);
      var swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = colors[value] || "#cbd5e1";
      row.appendChild(swatch);
      var label = document.createElement("span");
      label.textContent = value;
      row.appendChild(label);
      group.appendChild(row);
    });
    return { group: group, state: state };
  }

  var presentKinds = style.nodeKinds.filter(function (kind) {
    return graph.nodes.some(function (node) { return node.kind === kind; });
  });
  var presentStatuses = style.statuses.filter(function (status) {
    return graph.nodes.some(function (node) { return node.status === status; });
  });
  var presentEdgeTypes = style.edgeTypes.filter(function (type) {
    return graph.edges.some(function (edge) { return edge.type === type; });
  });

  var filterContainer = document.getElementById("filters");
  var kindFilter = buildFilterGroup("Node kind", presentKinds, style.kindColors);
  var statusFilter = buildFilterGroup("Status", presentStatuses, style.statusStrokes);
  var edgeFilter = buildFilterGroup("Edge type", presentEdgeTypes, style.edgeColors);
  filterContainer.appendChild(kindFilter.group);
  filterContainer.appendChild(statusFilter.group);
  filterContainer.appendChild(edgeFilter.group);

  presentKinds.forEach(function (kind) {
    var item = document.createElement("div");
    item.className = "legend-item";
    var swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = style.kindColors[kind] || "#64748b";
    item.appendChild(swatch);
    var label = document.createElement("span");
    label.textContent = kind;
    item.appendChild(label);
    legend.appendChild(item);
  });

  function applyFilters() {
    var query = search.value.trim().toLowerCase();
    var visible = {};
    graph.nodes.forEach(function (node) {
      var show =
        kindFilter.state[node.kind] !== false &&
        statusFilter.state[node.status] !== false &&
        matchesQuery(node, query);
      if (show) visible[node.id] = true;
      if (nodeElements[node.id]) {
        nodeElements[node.id].setAttribute("display", show ? "inline" : "none");
      }
    });
    visibleNodeIDs = visible;

    var visibleEdges = 0;
    edgeElements.forEach(function (item) {
      var edge = item.edge;
      var show =
        edgeFilter.state[edge.type] !== false &&
        Boolean(visible[edge.source]) &&
        Boolean(visible[edge.target]);
      item.element.setAttribute("display", show ? "inline" : "none");
      if (show) visibleEdges++;
    });

    stats.textContent =
      Object.keys(visible).length +
      " / " +
      graph.nodes.length +
      " nodes \u00b7 " +
      visibleEdges +
      " / " +
      graph.edges.length +
      " edges";

    if (selected && !visible[selected]) {
      selected = null;
      renderDetails(null);
    }
    updateHighlight();
  }

  function updateHighlight() {
    graph.nodes.forEach(function (node) {
      var element = nodeElements[node.id];
      if (!element) return;
      element.classList.remove("selected", "neighbor", "dim");
      if (!selected) return;
      if (node.id === selected) element.classList.add("selected");
      else if (neighbors[selected] && neighbors[selected][node.id]) element.classList.add("neighbor");
      else element.classList.add("dim");
    });
    edgeElements.forEach(function (item) {
      item.element.classList.remove("active", "dim");
      if (!selected) return;
      if (item.edge.source === selected || item.edge.target === selected) {
        item.element.classList.add("active");
      } else {
        item.element.classList.add("dim");
      }
    });
  }

  function renderDetails(node) {
    clear(details);
    if (!node) {
      addText(details, "p", "muted", "Select a node to inspect it.");
      return;
    }
    addText(details, "h3", "", node.title);
    addText(
      details,
      "p",
      "meta",
      node.kind +
        " \u00b7 " +
        node.status +
        " \u00b7 " +
        node.basis +
        " \u00b7 confidence " +
        node.confidence.toFixed(2) +
        " \u00b7 v" +
        node.version,
    );
    addText(details, "p", "meta", "Verification: " + node.verificationState);
    addText(details, "p", "body", node.body);

    if (node.scope.length) {
      var scope = document.createElement("div");
      scope.className = "chips";
      node.scope.forEach(function (value) {
        addText(scope, "span", "chip", "scope: " + value);
      });
      details.appendChild(scope);
    }
    if (node.tags.length) {
      var tags = document.createElement("div");
      tags.className = "chips";
      node.tags.forEach(function (value) {
        addText(tags, "span", "chip", "#" + value);
      });
      details.appendChild(tags);
    }
    addText(details, "p", "meta", "Created: " + node.createdAt);
    addText(details, "p", "meta", "Updated: " + node.updatedAt);

    var related = graph.edges.filter(function (edge) {
      return edge.source === node.id || edge.target === node.id;
    });
    addText(details, "p", "meta", related.length ? "Relationships" : "No relationships.");
    if (!related.length) return;
    var list = document.createElement("ul");
    list.className = "links";
    related.forEach(function (edge) {
      var outgoing = edge.source === node.id;
      var otherID = outgoing ? edge.target : edge.source;
      var other = nodeByID[otherID];
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.textContent =
        (outgoing ? "\u2192 " : "\u2190 ") +
        edge.type +
        (outgoing ? " \u2192 " : " \u2190 ") +
        (other ? other.title : otherID);
      button.addEventListener("click", function () {
        if (other) selectNode(other.id);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
    details.appendChild(list);
  }

  function selectNode(id) {
    if (id && !visibleNodeIDs[id]) return;
    selected = id && nodeByID[id] ? id : null;
    renderDetails(selected ? nodeByID[selected] : null);
    updateHighlight();
  }

  var suppressClick = false;
  svg.addEventListener("click", function (event) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    var target = event.target;
    if (!target || !target.closest || !target.closest(".node")) {
      selectNode(null);
    }
  });

  search.addEventListener("input", applyFilters);
  resetButton.addEventListener("click", resetView);

  var drag = null;
  svg.addEventListener("pointerdown", function (event) {
    var target = event.target;
    if (target && target.closest && target.closest(".node")) return;
    suppressClick = false;
    drag = {
      pointerID: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewX: view.x,
      viewY: view.y,
    };
    svg.classList.add("dragging");
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", function (event) {
    if (!drag || drag.pointerID !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.x) > 3 || Math.abs(event.clientY - drag.y) > 3) {
      suppressClick = true;
    }
    var rect = svg.getBoundingClientRect();
    view.x = drag.viewX - ((event.clientX - drag.x) / rect.width) * view.w;
    view.y = drag.viewY - ((event.clientY - drag.y) / rect.height) * view.h;
    applyView();
  });
  function endDrag(event) {
    if (!drag || drag.pointerID !== event.pointerId) return;
    drag = null;
    svg.classList.remove("dragging");
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener(
    "wheel",
    function (event) {
      event.preventDefault();
      var rect = svg.getBoundingClientRect();
      var pointerX = view.x + ((event.clientX - rect.left) / rect.width) * view.w;
      var pointerY = view.y + ((event.clientY - rect.top) / rect.height) * view.h;
      var factor = event.deltaY < 0 ? 0.85 : 1.18;
      var nextWidth = Math.max(120, Math.min(viewWidth * 4, view.w * factor));
      var nextHeight = view.h * (nextWidth / view.w);
      view.x = pointerX - ((pointerX - view.x) / view.w) * nextWidth;
      view.y = pointerY - ((pointerY - view.y) / view.h) * nextHeight;
      view.w = nextWidth;
      view.h = nextHeight;
      applyView();
    },
    { passive: false },
  );

  resetView();
  applyFilters();
})();
`;

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Fully self-contained HTML explorer. No network resource, timer, random
 * source, or current date is used, so the file is deterministic for a given
 * memory state.
 */
export function renderGraphHtml(graph: MemoryGraph): string {
  const data = {
    graph,
    layout: layoutGraph(graph),
    style: {
      kindColors: KIND_COLORS,
      edgeColors: EDGE_COLORS,
      statusStrokes: STATUS_STROKES,
      statusOpacity: STATUS_OPACITY,
      nodeKinds: NODE_KINDS,
      edgeTypes: EDGE_TYPES,
      statuses: NODE_STATUSES,
    },
    view: {
      width: GRAPH_VIEW_WIDTH,
      height: GRAPH_VIEW_HEIGHT,
    },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = graph.projectId
    ? `Goldfish memory graph \u2014 ${graph.projectId}`
    : "Goldfish memory graph";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>${EXPLORER_CSS}</style>
</head>
<body>
<header>
  <div>
    <h1>Goldfish memory graph</h1>
    <p class="stats" id="stats"></p>
  </div>
  <div class="grow"></div>
  <label class="search">Search <input id="search" type="search" placeholder="title or ID" autocomplete="off"></label>
  <button id="reset" type="button">Reset view</button>
</header>
<main>
  <div class="canvas">
    <svg id="graph" viewBox="0 0 ${GRAPH_VIEW_WIDTH} ${GRAPH_VIEW_HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Goldfish memory graph"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <aside>
    <section>
      <h2>Filters</h2>
      <div class="filters" id="filters"></div>
    </section>
    <section class="details">
      <h2>Details</h2>
      <div id="details"><p class="muted">Select a node to inspect it.</p></div>
    </section>
  </aside>
</main>
<noscript>This explorer needs JavaScript. The JSON, GraphML, and DOT exports remain available without it.</noscript>
<script id="goldfish-data" type="application/json">${json}</script>
<script>${EXPLORER_JS}</script>
</body>
</html>
`;
}
