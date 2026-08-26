import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWritableChangePath,
  extractPagePaths,
  joinDeckPath,
  normalizeRelativePath,
  parseYaml,
  patchYamlSource,
  renderPageSvg,
  titleFromManifest,
} from "../editor/lib.js";

const yaml = `---
version: v2
title: "测试文稿"
pages:
  - pages/01.page
  - 'pages/02.page' # comment
theme:
  colors: {}
`;

test("parses PPTD manifests and keeps file access inside the project", () => {
  assert.deepEqual(extractPagePaths(yaml), ["pages/01.page", "pages/02.page"]);
  assert.deepEqual(extractPagePaths('{"pages":["a.page","folder/b.page"]}'), ["a.page", "folder/b.page"]);
  assert.equal(titleFromManifest(yaml, "fallback"), "测试文稿");
  assert.equal(joinDeckPath("deck", "pages/01.page"), "deck/pages/01.page");
  assert.equal(joinDeckPath("deck", "deck/pages/01.page"), "deck/pages/01.page");
  assert.equal(assertWritableChangePath("deck", "pages/01.page"), "deck/pages/01.page");
  assert.throws(() => normalizeRelativePath("../secret"), /不允许越过/);
  assert.throws(() => normalizeRelativePath("/absolute/path"), /绝对路径/);
  assert.throws(() => assertWritableChangePath("deck", "media/image.png"), /仅允许编辑/);
});

test("patches edited YAML leaves without rewriting comments or unknown fields", () => {
  const source = `# keep\nelements:\n  - elementId: title\n    bounds: [1, 2, 3, 4] # position\n    content:\n      text: |\n        Before\nunknown: {future: true}\n`;
  const before = parseYaml(source);
  const after = structuredClone(before);
  after.elements[0].bounds = [10, 20, 30, 40];
  after.elements[0].content.text = "After\nSecond";
  const output = patchYamlSource(source, before, after);
  assert.match(output, /^# keep/m);
  assert.match(output, /bounds: \[10, 20, 30, 40\] # position/);
  assert.match(output, /text: \|\n        After\n        Second/);
  assert.match(output, /unknown: \{future: true\}/);
});

test("browser editor reuses the complete renderer for charts and merged tables", () => {
  const svg = renderPageSvg({
    background: { type: "solid", color: "#ffffff" },
    elements: [
      {
        elementId: "chart",
        elementType: "chart",
        bounds: [20, 20, 400, 220],
        data: { cols: ["x", "y"], rows: [["A", 2], ["B", 5]] },
        series: [{ type: "bar", encode: { x: "x", y: "y" } }],
      },
      {
        elementId: "table",
        elementType: "table",
        bounds: [20, 260, 400, 180],
        rows: [[{ text: "<strong>Merged</strong>", colSpan: 2 }, { text: "C" }], [{ text: "A" }, { text: "B" }, { text: "D" }]],
      },
    ],
  });
  assert.match(svg, /<rect[^>]+height="\d+(?:\.\d+)?"[^>]+fill="#1783FF"/);
  assert.match(svg, /<tspan[^>]+font-weight="700"[^>]*>Merged<\/tspan>/);
  assert.doesNotMatch(svg, /资源未本地化/);
});
