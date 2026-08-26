import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ECMA_PRESET_GEOMETRIES, exportPptx, latexToOmml, loadProject, makeZip, parseYaml, parseYamlCst, PRESET_SHAPE_NAMES, renderPageSvg, resolveProjectResource, setYamlCst, SHAPE_ADJUSTMENTS, SHAPE_ADJUSTMENT_NAMES, stringifyYamlCst, updateYamlCst, validateProject } from "../lib/pptd-core.js";

test("local YAML parser handles inline values, block text and unknown fields", () => {
  const value = parseYaml(`version: v2\ntitle: Example\nunknown: {keep: true}\npages:\n  - pages/01.page\nnotes: |\n  first paragraph\n\n  second paragraph\nitems:\n  - notes: |\n      first line\n\n      second line\n    id: item-1\n`);
  assert.equal(value.version, "v2");
  assert.deepEqual(value.unknown, { keep: true });
  assert.equal(value.notes, "first paragraph\n\nsecond paragraph");
  assert.equal(value.items[0].notes, "first line\n\nsecond line");
  assert.equal(value.items[0].id, "item-1");
});

test("local YAML parser accepts arbitrary indentation, nested sequences, BOM and scalar modifiers", () => {
  const value = parseYaml(`\uFEFF---\nroot:\n    child:\n        value: yes\nnegative:\n  -1\ndashText:\n  -draft\nitems:\n    - id: 1\n      nested:\n        x: 2\nrows:\n  - - content: {text: one}\n    - content: {text: two}\nliteral: |-\n  a\n  b\nfolded: >-\n  c\n  d\nfoldedParagraph: >-\n  one\n\n  two\nfoldedIndented: >-\n  one\n    indented\n  two\nkept: |+\n  x\n\n`);
  assert.equal(value.root.child.value, "yes");
  assert.equal(value.negative, -1);
  assert.equal(value.dashText, "-draft");
  assert.deepEqual(value.items, [{ id: 1, nested: { x: 2 } }]);
  assert.deepEqual(value.rows, [[{ content: { text: "one" } }, { content: { text: "two" } }]]);
  assert.equal(value.literal, "a\nb");
  assert.equal(value.folded, "c d");
  assert.equal(value.foldedParagraph, "one\ntwo");
  assert.equal(value.foldedIndented, "one\n  indented\ntwo");
  assert.match(value.kept, /^x\n/);
});

test("wraps long PPTD text in the local SVG renderer while preserving wrap=false", () => {
  const wrapped = renderPageSvg({ elements: [{ elementType: "text", bounds: [0, 0, 80, 80], content: { fontSize: 12, text: "这是一段需要自动换行的长文本" } }] }, { size: [80, 80] });
  assert.ok((wrapped.match(/data-rich-text="1"/g) ?? []).length > 1);
  const singleLine = renderPageSvg({ elements: [{ elementType: "text", bounds: [0, 0, 80, 80], content: { fontSize: 12, wrap: false, text: "这是一段需要自动换行的长文本" } }] }, { size: [80, 80] });
  assert.equal((singleLine.match(/data-rich-text="1"/g) ?? []).length, 1);
});

test("optionally exposes element metadata for browser animation targeting", () => {
  const page = { elements: [{ elementId: "title&lead", elementType: "text", bounds: [0, 0, 80, 20], content: { text: "Title" } }] };
  const plain = renderPageSvg(page, { size: [80, 20] });
  const interactive = renderPageSvg(page, { size: [80, 20], includeElementMetadata: true });
  assert.doesNotMatch(plain, /data-element-id=/);
  assert.match(interactive, /<g data-element-id="title&amp;lead" data-element-index="0">/);
});

test("PPTD project validates paths and renders native SVG", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-core-"));
  writeFileSync(join(root, "deck.pptd"), "version: v2\ntitle: Test\nsize: [960, 540]\npages:\n  - pages/01.page\n");
  writeFileSync(join(root, "pages.tmp"), "");
  const pages = join(root, "pages");
  mkdirSync(pages);
  writeFileSync(join(pages, "01.page"), "pageType: content\nelements:\n  - elementId: title\n    elementType: text\n    bounds: [20, 20, 400, 60]\n    content: {fontSize: 24, text: Hello}\n");
  const result = validateProject(root);
  assert.equal(result.valid, true);
  const project = loadProject(root);
  assert.match(renderPageSvg(project.pages[0].data, { size: project.size }), /Hello/);
});

test("keeps local media paths inside the project", () => {
  assert.throws(() => resolveProjectResource("/tmp/project", "../outside.png"), /资源路径越过项目目录/);
});

test("renders and exports image fills, table cell images, crop and cropShape resources", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-image-fill-"));
  mkdirSync(join(root, "media"));
  writeFileSync(join(root, "media", "pixel.png"), Buffer.from("not-a-real-png"));
  const page = { elements: [
    { elementId: "filled", elementType: "shape", shapeName: "roundRect", bounds: [0, 0, 200, 100], fill: { type: "image", src: "media/pixel.png", fit: { mode: "contain" }, crop: { left: .1 }, opacity: .7 } },
    { elementId: "photo", elementType: "image", bounds: [220, 0, 200, 100], src: "media/pixel.png", fit: { mode: "cover" }, crop: { top: .1 }, cropShape: { shapeName: "ellipse" } },
    { elementId: "table", elementType: "table", bounds: [0, 120, 420, 100], columnWidths: [1], rowHeights: [1], rows: [[{ text: "cell", fill: { type: "image", src: "media/pixel.png" } }]] },
  ] };
  const svg = renderPageSvg(page, { size: [480, 260], resourceResolver: () => "data:image/png;base64,AA==" });
  assert.ok((svg.match(/<image /g) ?? []).length >= 3);
  assert.match(svg, /<pattern[^>]+image-fill/);
  assert.match(svg, /<clipPath /);
  const project = { root, manifestPath: "deck.pptd", title: "Images", size: [480, 260], manifest: { version: "v2", title: "Images", size: [480, 260], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "pages", "01.page"), data: page }] };
  const output = join(root, "nested", "images.pptx");
  const result = exportPptx(project, output);
  assert.equal(result.media, 1);
  const slide = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  assert.ok((slide.match(/<a:blipFill>/g) ?? []).length >= 2);
  assert.match(slide, /<a:alphaModFix amt="70000"\/>/);
  const rels = execFileSync("unzip", ["-p", output, "ppt/slides/_rels/slide1.xml.rels"], { encoding: "utf8" });
  assert.match(rels, /relationships\/image/);
});

test("fails export explicitly when a referenced local image is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-missing-image-"));
  const project = { root, manifestPath: "deck.pptd", title: "Missing", size: [100, 100], manifest: { version: "v2", size: [100, 100], theme: {} }, pages: [{ path: "pages/01.page", data: { elements: [{ elementType: "image", bounds: [0, 0, 50, 50], src: "media/nope.png" }] } }] };
  assert.throws(() => exportPptx(project, join(root, "missing.pptx")), /找不到本地资源/);
});

test("detects remote image fills declared in manifest theme styles", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-theme-image-"));
  const manifest = { version: "v2", size: [100, 100], theme: { tableStyles: { photo: { cellStyle: { fill: { type: "image", src: "https://example.com/photo.png" } } } } } };
  const table = { elementType: "table", bounds: [0, 0, 100, 100], style: "$photo", columnWidths: [1], rowHeights: [1], rows: [[{ text: "cell" }]] };
  const project = { root, manifestPath: "deck.pptd", title: "Theme image", size: [100, 100], manifest, pages: [{ path: "pages/01.page", data: { elements: [table] } }] };
  assert.throws(() => exportPptx(project, join(root, "theme-image.pptx")), /未本地化的远程资源/);
});

test("exports speaker notes into notesSlide parts", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-notes-"));
  const project = { root, manifestPath: "deck.pptd", title: "Notes", size: [100, 100], manifest: { version: "v2", size: [100, 100], theme: {} }, pages: [{ path: "pages/01.page", data: { notes: "第一行\n第二行", elements: [] } }] };
  const output = join(root, "notes.pptx");
  exportPptx(project, output);
  const notes = execFileSync("unzip", ["-p", output, "ppt/notesSlides/notesSlide1.xml"], { encoding: "utf8" });
  assert.match(notes, /第一行/);
  assert.match(notes, /第二行/);
  const slideRels = execFileSync("unzip", ["-p", output, "ppt/slides/_rels/slide1.xml.rels"], { encoding: "utf8" });
  assert.match(slideRels, /relationships\/notesSlide/);
});

test("OOXML export is a readable ZIP with native slide parts and transitions", () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-core-"));
  const project = { root, manifestPath: "deck.pptd", title: "Test", size: [960, 540], manifest: { version: "v2", title: "Test", size: [960, 540], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: { elements: [{ elementType: "text", bounds: [0, 0, 200, 40], content: { text: "Editable" } }] } }] };
  const output = join(root, "deck.pptx");
  exportPptx(project, output);
  assert.equal(existsSync(output), true);
  const bytes = readFileSync(output);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(makeZip({ "hello.txt": "world" }).readUInt32LE(0) === 0x04034b50);
});

test("encodes eight-digit gradient colors with numeric alpha values", () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-gradient-"));
  const project = {
    root,
    manifestPath: "deck.pptd",
    title: "Gradient",
    size: [960, 540],
    manifest: { version: "v2", title: "Gradient", size: [960, 540], theme: {} },
    pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: { background: { type: "solid", color: "#ffffff" }, elements: [{ elementType: "shape", shapeName: "rect", bounds: [0, 0, 960, 540], fill: { type: "gradient", angle: 90, stops: [{ position: 0, color: "#00000020" }, { position: 1, color: "#000000e0" }] } }, { elementType: "shape", shapeName: "ellipse", bounds: [20, 20, 100, 80], fill: { type: "gradient", gradientType: "radial", stops: [{ position: 0, color: "#FFFFFF" }, { position: 1, color: "#000000" }] } }] } }],
  };
  const output = join(root, "gradient.pptx");
  exportPptx(project, output);
  const xml = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  assert.doesNotMatch(xml, /NaN/);
  assert.match(xml, /<a:alpha val="12549"\/>/);
  assert.match(xml, /<a:path path="circle"\/>/);
  const svg = renderPageSvg(project.pages[0].data, { size: [960, 540] });
  assert.match(svg, /<radialGradient /);
});

test("CST updates keep comments, key order, unknown fields and untouched formatting", () => {
  const source = `# page comment\nelements:\n  - elementId: title # keep inline\n    bounds: [1, 2, 3, 4] # keep bounds\n    content:\n      text: |\n        old text\n# trailing comment\nunknownField: keep-me\n`;
  const document = parseYamlCst(source);
  setYamlCst(document, ["elements", 0, "bounds"], [10, 20, 30, 40]);
  setYamlCst(document, ["elements", 0, "content", "text"], "new text\nsecond line");
  const output = stringifyYamlCst(document);
  assert.match(output, /^# page comment/m);
  assert.match(output, /bounds: \[10, 20, 30, 40\] # keep bounds/);
  assert.match(output, /text: \|\n        new text\n        second line/);
  assert.ok(output.indexOf("# trailing comment") < output.indexOf("unknownField"));
  assert.equal(parseYaml(output).unknownField, "keep-me");
});

test("CST structural edits replace only the changed collection subtree", () => {
  const source = `# manifest comment\nversion: v2\npages: # page list\n  # cover page stays attached\n  - pages/01.page # keep page inline\n# keep between sections\ntheme:\n  colors: {primary: \"#2563EB\"}\nunknown: keep\n`;
  const document = parseYamlCst(source); const next = structuredClone(document.value); next.pages.push("pages/02.page"); updateYamlCst(document, next); const output = stringifyYamlCst(document);
  assert.match(output, /^# manifest comment/m);
  assert.match(output, /pages: # page list\n  # cover page stays attached\n  - pages\/01\.page # keep page inline\n  - pages\/02\.page/);
  assert.match(output, /# keep between sections\ntheme:/);
  assert.match(output, /unknown: keep/);

  const reordered = parseYamlCst(`pages:\n  - pages/a.page # first slot\n  # keep in the middle\n  - pages/b.page # second slot\ntitle: Deck\n`);
  const reorderedValue = structuredClone(reordered.value); reorderedValue.pages.reverse(); updateYamlCst(reordered, reorderedValue); const reorderedOutput = stringifyYamlCst(reordered);
  assert.match(reorderedOutput, /- pages\/b\.page # first slot\n  # keep in the middle\n  - pages\/a\.page # second slot/);

  const page = parseYamlCst(`elements:\n  # original element\n  - elementId: title # keep id comment\n    elementType: text\n    bounds: [0, 0, 100, 20]\n# next section\nnotes: keep\n`);
  const pageValue = structuredClone(page.value); pageValue.elements.push({ elementId: "accent", elementType: "shape", bounds: [0, 30, 100, 4], shapeName: "rect" }); updateYamlCst(page, pageValue); const pageOutput = stringifyYamlCst(page);
  assert.match(pageOutput, /# original element\n  - elementId: title # keep id comment/);
  assert.match(pageOutput, /  - elementId: accent\n    elementType: shape/);
  assert.match(pageOutput, /# next section\nnotes: keep/);
});

test("CST mapping edits preserve surrounding and trailing comments", () => {
  const document = parseYamlCst(`# header\nversion: v2 # inline\nmeta:\n  # keep nested\n  author: Ada\n  obsolete: remove\n# trailing document comment\n`);
  const next = structuredClone(document.value);
  delete next.meta.obsolete;
  next.meta.year = 2026;
  next.pages = ["pages/01.page"];
  updateYamlCst(document, next);
  const output = stringifyYamlCst(document);
  assert.match(output, /^# header\nversion: v2 # inline/m);
  assert.match(output, /meta:\n  # keep nested\n  author: Ada\n  year: 2026/);
  assert.match(output, /pages:\n  - pages\/01\.page\n# trailing document comment/);
  assert.equal(parseYaml(output).meta.obsolete, undefined);
});

test("exports all 177 preset shapes with complete adjustment lists", () => {
  assert.equal(PRESET_SHAPE_NAMES.length, 177);
  assert.equal(new Set(PRESET_SHAPE_NAMES).size, 177);
  assert.equal(Object.keys(ECMA_PRESET_GEOMETRIES).length, 177);
  assert.equal(Object.keys(SHAPE_ADJUSTMENTS).length, 177);
  assert.equal(Object.keys(SHAPE_ADJUSTMENT_NAMES).length, 177);
  assert.deepEqual([...new Set(Object.values(ECMA_PRESET_GEOMETRIES).flatMap((definition) => definition.g.map((guide) => guide[1])))].sort((a, b) => a - b), Array.from({ length: 17 }, (_, index) => index));
  assert.deepEqual([...new Set(Object.values(ECMA_PRESET_GEOMETRIES).flatMap((definition) => definition.p.map((command) => command[0])))].sort((a, b) => a - b), Array.from({ length: 7 }, (_, index) => index));
  for (const [shapeName, values] of Object.entries(SHAPE_ADJUSTMENTS)) assert.equal(SHAPE_ADJUSTMENT_NAMES[shapeName].length, values.length);
  assert.deepEqual(SHAPE_ADJUSTMENTS.foldedCorner, [16667]);
  assert.deepEqual(SHAPE_ADJUSTMENTS.upDownArrow, [50000, 50000]);
  assert.deepEqual(SHAPE_ADJUSTMENT_NAMES.pentagon, ["hf", "vf"]);
  assert.deepEqual(SHAPE_ADJUSTMENT_NAMES.hexagon, ["adj", "vf"]);
  assert.deepEqual(SHAPE_ADJUSTMENT_NAMES.star5, ["adj", "hf", "vf"]);
  assert.deepEqual(ECMA_PRESET_GEOMETRIES.moon.g.find(([name]) => name === "a"), ["a", 10, "0", "adj", "87500"]);
  assert.equal(ECMA_PRESET_GEOMETRIES.gear6.p.filter(([kind]) => kind === 3).length, 6);
  assert.equal(ECMA_PRESET_GEOMETRIES.gear9.p.filter(([kind]) => kind === 3).length, 9);
  for (const shapeName of ["gear6", "gear9"]) for (const command of ECMA_PRESET_GEOMETRIES[shapeName].p.filter(([kind]) => kind === 3)) assert.deepEqual(command.slice(1, 3), ["rw", "rh"]);
  assert.deepEqual(ECMA_PRESET_GEOMETRIES.cloud.p[0], [0, null, null, null, 43200, 43200]);
  assert.deepEqual(ECMA_PRESET_GEOMETRIES.wedgeRectCallout.a, [["adj1", -20833], ["adj2", 62500]]);
  assert.deepEqual(ECMA_PRESET_GEOMETRIES.noSmoking.p.slice(7).map((command) => command[0]), [1, 3, 6, 1, 3, 6]);
  assert.deepEqual(ECMA_PRESET_GEOMETRIES.flowChartMagneticTape.p[5], [3, "wd2", "hd2", 0, "ang1"]);
  const root = mkdtempSync(join(tmpdir(), "pptx-shapes-"));
  const elements = PRESET_SHAPE_NAMES.map((shapeName, index) => ({ elementId: `shape-${index}`, elementType: "shape", shapeName, adjustments: SHAPE_ADJUSTMENTS[shapeName], bounds: [(index % 20) * 20, Math.floor(index / 20) * 20, 18, 18], fill: { type: "solid", color: "#1783FF" } }));
  const project = { root, manifestPath: "deck.pptd", title: "Shapes", size: [960, 540], manifest: { version: "v2", title: "Shapes", size: [960, 540], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: { elements } }] };
  const output = join(root, "shapes.pptx"); exportPptx(project, output);
  const xml = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  for (const shapeName of PRESET_SHAPE_NAMES) assert.match(xml, new RegExp(`<a:prstGeom prst="${shapeName}">`));
  assert.match(xml, /<a:prstGeom prst="rightArrow"><a:avLst><a:gd name="adj1" fmla="val 50000"\/><a:gd name="adj2" fmla="val 50000"\/>/);
  assert.match(xml, /<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"\/>/);
  assert.match(xml, /<a:prstGeom prst="star5"><a:avLst><a:gd name="adj" fmla="val 19098"\/><a:gd name="hf" fmla="val 105146"\/><a:gd name="vf" fmla="val 110557"\/>/);
});

test("renders every ECMA preset geometry without non-finite path coordinates", () => {
  for (const shapeName of PRESET_SHAPE_NAMES) {
    for (const adjustments of [SHAPE_ADJUSTMENTS[shapeName], SHAPE_ADJUSTMENTS[shapeName].map(() => 0), SHAPE_ADJUSTMENTS[shapeName].map(() => 100000)]) {
      const svg = renderPageSvg({ elements: [{ elementId: shapeName, elementType: "shape", shapeName, adjustments, bounds: [0, 0, 320, 180], fill: "#1783FF", border: { color: "#111827", width: 1 } }] }, { size: [320, 180] });
      assert.match(svg, /<path\b[^>]*\bd="/);
      assert.doesNotMatch(svg, /(?:NaN|Infinity|undefined)/);
    }
  }
  const roundRect = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "roundRect", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  assert.equal((roundRect.match(/ A /g) ?? []).length, 4);
  const ellipse = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "ellipse", bounds: [0, 0, 320, 180], fill: "#1783FF" }] }, { size: [320, 180] });
  const ellipsePath = ellipse.match(/<path d="([^"]+)"/)?.[1] ?? "";
  const ellipseArcs = [...ellipsePath.matchAll(/A\s+(\S+)\s+(\S+)\s+0\s+([01])\s+([01])\s+(\S+)\s+(\S+)/g)];
  assert.equal(ellipseArcs.length, 4);
  for (const arc of ellipseArcs) assert.deepEqual(arc.slice(1, 5).map(Number), [160, 90, 0, 1]);
  assert.ok(Math.hypot(Number(ellipseArcs.at(-1)[5]), Number(ellipseArcs.at(-1)[6]) - 90) < 1e-9);
  const donut = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "donut", bounds: [0, 0, 320, 180], fill: "#1783FF" }] }, { size: [320, 180] });
  const donutSweeps = [...(donut.match(/<path d="([^"]+)"/)?.[1] ?? "").matchAll(/A\s+\S+\s+\S+\s+0\s+[01]\s+([01])/g)].map((match) => Number(match[1]));
  assert.deepEqual(donutSweeps, [1, 1, 1, 1, 0, 0, 0, 0]);
  const moon = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "moon", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  assert.match(moon, /A [\d.]+ [\d.]+ 0 [01] [01] 199\.999/);
  const bevel = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "bevel", bounds: [0, 0, 200, 160], fill: "#808080" }] }, { size: [200, 160] });
  assert.match(bevel, /fill="#999999"/);
  assert.match(bevel, /fill="#666666"/);
  assert.match(bevel, /fill="#4d4d4d"/);
  const translucentBevel = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "bevel", bounds: [0, 0, 200, 160], fill: "#80808080" }] }, { size: [200, 160] });
  assert.match(translucentBevel, /fill="rgba\(153,153,153,0\.502\)"/);
  assert.match(translucentBevel, /fill="rgba\(77,77,77,0\.502\)"/);
  const gradientBevel = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "bevel", bounds: [0, 0, 200, 160], fill: { type: "gradient", angle: 0, stops: [{ position: 0, color: "#80808080" }, { position: 1, color: "#204060" }] } }] }, { size: [200, 160] });
  assert.equal((gradientBevel.match(/<linearGradient /g) ?? []).length, 5);
  for (const color of ["rgba(153,153,153,0.502)", "#4d6680", "#1a334d", "#798ca0", "#13263a"]) assert.ok(gradientBevel.includes(`stop-color="${color}"`));
  const noSmoking = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "noSmoking", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  const noSmokingPath = noSmoking.match(/<path d="([^"]+)"/)?.[1] ?? "";
  assert.equal((noSmokingPath.match(/\bM /g) ?? []).length, 3);
  assert.equal((noSmokingPath.match(/\bA /g) ?? []).length, 6);
  const gear6 = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "gear6", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  assert.equal((gear6.match(/ A 76 56 /g) ?? []).length, 6);
  const cloud = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "cloud", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  assert.match(cloud, /M 18\.055555555555554 53\.22222222222222 A 31\.263888888888886 34\.03703703703704/);
  const wedge = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "wedgeRectCallout", bounds: [0, 0, 200, 160], fill: "#1783FF" }] }, { size: [200, 160] });
  assert.match(wedge, /L 58\.334 180 L 33\.333333333333336 160/);
  const transformed = renderPageSvg({ elements: [{ elementType: "shape", shapeName: "roundRect", bounds: [20, 30, 160, 100], rotation: 90, flip: [true, false], fill: "#1783FF" }] }, { size: [220, 180] });
  assert.match(transformed, /<g transform="translate\(100 80\) rotate\(90\) scale\(-1 1\) translate\(-100 -80\)">/);
});

test("exports rich text, editable OMML equations, and merged native tables", () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-rich-table-"));
  const page = { elements: [
    { elementId: "rich", elementType: "text", bounds: [20, 20, 500, 80], rotation: 5, opacity: .8, content: { fontSize: 20, fontFamily: "Arial, Microsoft YaHei", align: ["left", "middle"], padding: [2, 4], gradient: { type: "gradient", angle: 0, stops: [{ position: 0, color: "#2563EB" }, { position: 1, color: "#DC2626" }] }, text: '<p><strong>Bold</strong> <em>italic</em> <u>under</u> <s>strike</s> H<sub>2</sub> x<sup>2</sup> <a href="https://example.com?a=1&amp;b=2">link</a> \\(\\frac{a^2}{b_1} + \\sqrt{x} + \\int_0^1 x\\)</p><ul><li>Bullet</li></ul><ol><li style="list-style-type:upper-roman">One</li></ol>' } },
    { elementId: "table", elementType: "table", bounds: [20, 120, 600, 300], fill: { type: "solid", color: "#F8FAFC" }, columnWidths: [.3, .3, .4], rowHeights: [.5, .5], rows: [[{ text: "Merged", rowSpan: 2, colSpan: 2 }, { text: "C1" }], [{ text: "C2" }]] },
  ] };
  const project = { root, manifestPath: "deck.pptd", title: "Rich", size: [960, 540], manifest: { version: "v2", title: "Rich", size: [960, 540], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: page }] };
  const output = join(root, "rich.pptx"); exportPptx(project, output);
  const xml = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  assert.match(xml, /<a:rPr[^>]* b="1"/);
  assert.match(xml, /<a:rPr[^>]* i="1"/);
  assert.match(xml, / u="sng"/);
  assert.match(xml, / strike="sngStrike"/);
  assert.match(xml, / baseline="-25000"/);
  assert.match(xml, / baseline="30000"/);
  assert.match(xml, /<a:buChar char="•"\/>/);
  assert.match(xml, /<a14:m[^>]*><m:oMath><m:f>/);
  assert.match(xml, /<m:radPr><m:degHide m:val="1"\/>/);
  assert.match(xml, /<m:nary><m:naryPr><m:chr m:val="∫"\/>/);
  assert.match(xml, /<a:buAutoNum type="romanUcPeriod" startAt="1"\/>/);
  assert.match(xml, /<a:gradFill rotWithShape="1">/);
  assert.match(xml, /<a:latin typeface="Arial"\/><a:ea typeface="Microsoft YaHei"\/>/);
  assert.match(xml, /<a:bodyPr wrap="square" anchor="ctr" lIns="38100" tIns="19050" rIns="38100" bIns="19050"\/>/);
  assert.match(xml, /gridSpan="2" rowSpan="2"/);
  assert.match(xml, /hMerge="1"/);
  assert.match(xml, /vMerge="1"/);
  const rels = execFileSync("unzip", ["-p", output, "ppt/slides/_rels/slide1.xml.rels"], { encoding: "utf8" });
  assert.match(rels, /relationships\/hyperlink/);
  assert.match(rels, /Target="https:\/\/example.com\?a=1&amp;b=2" TargetMode="External"/);
});

test("converts structured LaTeX constructs to editable OMML", () => {
  const omml = latexToOmml(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}+\overline{x}+\hat{y}+\binom{n}{k}+\left\langle x,y\right\rangle+\overset{!}{=}+\boxed{z}`);
  assert.match(omml, /<m:d><m:dPr><m:begChr m:val="\("\/><m:endChr m:val="\)"\/>/);
  assert.equal((omml.match(/<m:mr>/g) ?? []).length, 2);
  assert.equal((omml.match(/<m:e>/g) ?? []).length >= 5, true);
  assert.match(omml, /<m:bar><m:barPr><m:pos m:val="top"\/>/);
  assert.match(omml, /<m:acc><m:accPr><m:chr m:val="̂"\/>/);
  assert.match(omml, /<m:type m:val="noBar"\/>/);
  assert.match(omml, /<m:begChr m:val="⟨"\/><m:endChr m:val="⟩"\/>/);
  assert.match(omml, /<m:limUpp>/);
  assert.match(omml, /<m:borderBox>/);
});

test("rejects invalid table merge spans and grid dimensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pptd-table-validation-"));
  mkdirSync(join(root, "pages"));
  writeFileSync(join(root, "deck.pptd"), "version: v2\nsize: [960, 540]\npages: [pages/01.page]\n");
  writeFileSync(join(root, "pages/01.page"), JSON.stringify({ elements: [{ elementId: "table", elementType: "table", bounds: [0, 0, 400, 200], columnWidths: [1], rowHeights: [1], rows: [[{ text: "bad", rowSpan: 1.5, colSpan: 2 }]] }] }));
  const result = validateProject(root);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === "table-merge"));
  assert.ok(result.errors.some((issue) => issue.code === "table-size"));
});

test("encodes all 13 chart types from PPTD data into chart parts and editable workbooks", () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-charts-"));
  const fixtures = [
    ["bar", ["x", "y"], [["A", 2], ["B", 5]], { x: "x", y: "y" }, { dataLabels: false }],
    ["line", ["x", "y"], [["A", 2], ["B", 5]], { x: "x", y: "y" }, { marker: false, smooth: true, width: 3, lineColor: { type: "gradient", angle: 0, stops: [{ position: 0, color: "#2563EB" }, { position: 1, color: "#DC2626" }] } }],
    ["area", ["x", "y"], [["A", 2], ["B", 5]], { x: "x", y: "y" }],
    ["scatter", ["group", "x", "y"], [["A", 1, 2], ["B", 3, 5]], { x: "x", y: "y" }, { dataFilter: { col: "group", value: "A" }, marker: { shape: "diamond", size: 9 } }],
    ["bubble", ["x", "y", "size"], [[1, 2, 9], [3, 5, 16]], { x: "x", y: "y", size: "size" }, { sizeScale: "log", sizeRange: [4, 24] }],
    ["candlestick", ["x", "open", "high", "low", "close"], [["D1", 2, 6, 1, 5], ["D2", 5, 7, 3, 4]], { x: "x", open: "open", high: "high", low: "low", close: "close" }, { wickStyle: { color: "#475569", width: 2, style: "dash" }, upBars: { fill: "#22C55E", border: { color: "#15803D", width: 2 } }, downBars: { fill: "#EF4444", border: { color: "#991B1B", width: 2 } } }],
    ["pie", ["category", "value"], [["A", 2], ["B", 5]], { category: "category", value: "value" }],
    ["radar", ["category", "y"], [["A", 2], ["B", 5], ["C", 4]], { category: "category", y: "y" }],
    ["waterfall", ["x", "y", "total"], [["Start", 5, true], ["Gain", 2, false]], { x: "x", y: "y", isTotal: "total" }],
    ["heatmap", ["x", "y", "value"], [["A", "R1", 2], ["B", "R1", 5]], { x: "x", y: "y", value: "value" }, { colorScheme: ["#2563EB", "#FFFFFF", "#DC2626"], colorScale: { type: "diverging", domain: [-5, 5] }, colorbar: true }],
    ["treemap", ["category", "value", "parent"], [["A", 2, null], ["B", 5, "A"]], { category: "category", value: "value", parent: "parent" }, { fill: [[{ type: "gradient", angle: 35, stops: [{ position: 0, color: "#2563EB" }, { position: 1, color: "#06B6D4" }] }, "#1D4ED8"]], border: { color: "#FFFFFF", width: 1 } }],
    ["sunburst", ["category", "value", "parent"], [["A", 2, null], ["B", 5, "A"], ["C", 3, null]], { category: "category", value: "value", parent: "parent" }, { fill: [{ type: "gradient", angle: 70, stops: [{ position: 0, color: "#F97316" }, { position: 1, color: "#DB2777" }] }, "#2563EB"], border: { color: "#FFFFFF", width: 1 } }],
    ["sankey", ["source", "target", "flow"], [["A", "B", 2], ["B", "C", 5]], { source: "source", target: "target", flow: "flow" }, { nodeAlign: "justify", fill: { A: "#2563EB", B: "#16A34A", C: "#DC2626" } }],
  ];
  const pages = fixtures.map(([type, cols, rows, encode, options = {}], index) => ({ path: `pages/${index}.page`, absolutePath: join(root, `${index}.page`), data: { elements: [{ elementId: type, elementType: "chart", bounds: [40, 40, 700, 400], data: { cols, rows }, title: `${type} title`, legend: { show: true, position: "right", fontSize: 9, color: "#334155" }, dataLabels: { show: true, content: type === "pie" ? "percentage" : type === "treemap" || type === "sunburst" ? "category" : "value" }, series: [{ type, encode, ...options }] }] } }));
  Object.assign(pages[0].data.elements[0], { xAxis: { axisLine: { color: "#334155", width: 2, arrow: "both" }, gridLine: false }, yAxis: { min: 0, max: 10, label: { numberFormat: "0.0", fontSize: 8 } } });
  Object.assign(pages[1].data.elements[0], { fill: { type: "solid", color: "#F8FAFC" }, border: { color: "#CBD5E1", width: 1 }, fontFamily: { latin: "Arial", ea: "Microsoft YaHei" } });
  pages[7].data.elements[0].spokeAxis = { min: 0, max: 8, label: { fontSize: 8, color: "#475569" }, axisLine: { color: "#64748B" }, gridLine: { color: "#CBD5E1", style: "dot" } };
  delete pages[8].data.elements[0].legend;
  const treemapSvg = renderPageSvg(pages[10].data, { size: [960, 540] });
  const sunburstSvg = renderPageSvg(pages[11].data, { size: [960, 540] });
  assert.ok((treemapSvg.match(/<rect /g) ?? []).length >= 3);
  assert.ok((sunburstSvg.match(/<path /g) ?? []).length >= 2);
  assert.ok((sunburstSvg.match(/ A /g) ?? []).length >= 3);
  assert.ok((treemapSvg.match(/<linearGradient /g) ?? []).length >= 1);
  assert.ok((sunburstSvg.match(/<linearGradient /g) ?? []).length >= 2);
  const combinedSvg = renderPageSvg({ elements: [structuredClone(pages[10].data.elements[0]), { ...structuredClone(pages[11].data.elements[0]), bounds: [40, 40, 500, 300] }] }, { size: [960, 540] });
  const gradientIds = [...combinedSvg.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(gradientIds).size, gradientIds.length);
  for (const id of gradientIds) assert.match(combinedSvg, new RegExp(`url\\(#${id}\\)`));
  const hierarchyColors = renderPageSvg({ elements: [{ elementId: "tree-gray", elementType: "chart", bounds: [0, 0, 400, 240], data: { cols: ["category", "value", "parent"], rows: [["root", 1, null], ["child", 1, "root"]] }, series: [{ type: "treemap", encode: { category: "category", value: "value", parent: "parent" }, fill: "#808080" }] }] }, { size: [400, 240] });
  assert.match(hierarchyColors, /fill="#808080"/);
  assert.match(hierarchyColors, /fill="#676767"/);
  const sunburstColors = renderPageSvg({ elements: [{ elementId: "sun-colors", elementType: "chart", bounds: [0, 0, 400, 240], data: { cols: ["category", "value"], rows: [["A", 1], ["B", 1]] }, series: [{ type: "sunburst", encode: { category: "category", value: "value" }, fill: ["#EF4444", "#2563EB"] }] }] }, { size: [400, 240] });
  assert.match(sunburstColors, /fill="#EF4444"/);
  assert.match(sunburstColors, /fill="#2563EB"/);
  const nestedSunburstColors = renderPageSvg({ elements: [{ elementId: "nested-sun-colors", elementType: "chart", bounds: [0, 0, 400, 240], data: { cols: ["category", "value", "parent"], rows: [["A", 2, null], ["A-child", 1, "A"], ["B", 1, null]] }, series: [{ type: "sunburst", encode: { category: "category", value: "value", parent: "parent" }, fill: ["#EF4444", "#2563EB"] }] }] }, { size: [400, 240] });
  const nestedSunburstFills = [...nestedSunburstColors.matchAll(/<path d="[^"]+" fill="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1]);
  assert.deepEqual(nestedSunburstFills, ["#EF4444", "#EF4444", "#2563EB"]);
  const emptySunburstPalette = renderPageSvg({ elements: [{ elementId: "empty-sun-colors", elementType: "chart", bounds: [0, 0, 400, 240], data: { cols: ["category", "value"], rows: [["A", 1]] }, series: [{ type: "sunburst", encode: { category: "category", value: "value" }, fill: [] }] }] }, { size: [400, 240] });
  assert.match(emptySunburstPalette, /<path d="[^"]+" fill="#1783FF"/);
  const project = { root, manifestPath: "deck.pptd", title: "Charts", size: [960, 540], manifest: { version: "v2", title: "Charts", size: [960, 540], theme: {} }, pages };
  const output = join(root, "charts.pptx"); const result = exportPptx(project, output);
  assert.equal(result.charts, 9);
  const listing = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" });
  assert.equal((listing.match(/ppt\/charts\/chart\d+\.xml$/gm) ?? []).length, 9);
  const workbook = execFileSync("unzip", ["-p", output, "ppt/embeddings/chart1.xlsx"], { encoding: null });
  const workbookPath = join(root, "chart1.xlsx"); writeFileSync(workbookPath, workbook);
  const sheet = execFileSync("unzip", ["-p", workbookPath, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.match(sheet, /<t>x<\/t>/);
  assert.match(sheet, /<v>5<\/v>/);
  const stock = execFileSync("unzip", ["-p", output, "ppt/charts/chart6.xml"], { encoding: "utf8" });
  assert.match(stock, /<c:stockChart>/);
  assert.match(stock, /<c:upDownBars>/);
  assert.match(stock, /<c:hiLowLines><c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="475569"/);
  assert.match(stock, /<c:upBars><c:spPr><a:solidFill><a:srgbClr val="22C55E"/);
  assert.match(stock, /<a:srgbClr val="15803D"/);
  const barChart = execFileSync("unzip", ["-p", output, "ppt/charts/chart1.xml"], { encoding: "utf8" });
  assert.doesNotMatch(barChart, /<c:dLbls>/);
  assert.match(barChart, /<a:headEnd type="triangle"\/><a:tailEnd type="triangle"\/>/);
  const lineChart = execFileSync("unzip", ["-p", output, "ppt/charts/chart2.xml"], { encoding: "utf8" });
  assert.match(lineChart, /<c:marker><c:symbol val="none"\/><\/c:marker>/);
  assert.match(lineChart, /<a:gradFill rotWithShape="1">/);
  assert.match(lineChart, /<\/c:chart><c:spPr>/);
  assert.match(lineChart, /<c:txPr>.*<a:latin typeface="Arial"\/><a:ea typeface="Microsoft YaHei"\/>/);
  const radar = execFileSync("unzip", ["-p", output, "ppt/charts/chart8.xml"], { encoding: "utf8" });
  assert.match(radar, /<c:min val="0"\/><c:max val="8"\/>|<c:max val="8"\/><c:min val="0"\/>/);
  assert.match(radar, /<a:prstDash val="dot"\/>/);
  const filteredWorkbook = execFileSync("unzip", ["-p", output, "ppt/embeddings/chart4.xlsx"], { encoding: null });
  const filteredPath = join(root, "chart4.xlsx"); writeFileSync(filteredPath, filteredWorkbook);
  const filteredSheet = execFileSync("unzip", ["-p", filteredPath, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.match(filteredSheet, /__pptd_s1_x/);
  assert.match(filteredSheet, /__pptd_s1_y/);
  const waterfall = execFileSync("unzip", ["-p", output, "ppt/charts/chart9.xml"], { encoding: "utf8" });
  assert.match(waterfall, /<c:grouping val="stacked"/);
  assert.equal((waterfall.match(/<c:ser>/g) ?? []).length, 2);
  assert.match(waterfall, /<a:alpha val="0"/);
  assert.doesNotMatch(waterfall, /<c:legend>/);
  const heatmapSlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide10.xml"], { encoding: "utf8" });
  const treemapSlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide11.xml"], { encoding: "utf8" });
  const sunburstSlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide12.xml"], { encoding: "utf8" });
  const treemapRels = execFileSync("unzip", ["-p", output, "ppt/slides/_rels/slide11.xml.rels"], { encoding: "utf8" });
  const sunburstRels = execFileSync("unzip", ["-p", output, "ppt/slides/_rels/slide12.xml.rels"], { encoding: "utf8" });
  const sankeySlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide13.xml"], { encoding: "utf8" });
  assert.match(heatmapSlide, /<p:grpSp>/);
  assert.match(heatmapSlide, /heatmap-cell-1/);
  assert.doesNotMatch(heatmapSlide, /<c:chart/);
  assert.match(treemapSlide, /<p:grpSp>/);
  assert.match(treemapSlide, /treemap-node-1/);
  assert.match(treemapSlide, /treemap-label-1/);
  assert.match(treemapSlide, /<a:gradFill rotWithShape="1">/);
  assert.match(treemapSlide, /<a:off x="381000" y="381000"\/><a:ext cx="6667500" cy="3810000"\/><a:chOff x="0" y="0"\/><a:chExt cx="6667500" cy="3810000"\/>/);
  assert.doesNotMatch(treemapSlide, /<c:chart/);
  assert.doesNotMatch(treemapRels, /relationships\/chart/);
  assert.match(sunburstSlide, /<p:grpSp>/);
  assert.match(sunburstSlide, /sunburst-node-1/);
  assert.match(sunburstSlide, /<a:custGeom>/);
  assert.match(sunburstSlide, /name="sunburst-node-1"[\s\S]*?<a:custGeom>[\s\S]*?<a:cubicBezTo>/);
  assert.ok((sunburstSlide.match(/<a:cubicBezTo>/g) ?? []).length >= 3);
  assert.match(sunburstSlide, /<a:gradFill rotWithShape="1">/);
  const sunburstNodes = new Map([...sunburstSlide.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="sunburst-node-(\d+)"[\s\S]*?<\/p:sp>/g)].map((match) => [Number(match[1]), match[0]]));
  assert.match(sunburstNodes.get(1) ?? "", /<a:gradFill rotWithShape="1">/);
  assert.match(sunburstNodes.get(2) ?? "", /<a:gradFill rotWithShape="1">/);
  assert.match(sunburstNodes.get(3) ?? "", /<a:solidFill><a:srgbClr val="2563EB"/);
  for (const node of sunburstNodes.values()) assert.match(node, /<a:cubicBezTo>/);
  assert.doesNotMatch(sunburstSlide, /<c:chart/);
  assert.doesNotMatch(sunburstRels, /relationships\/chart/);
  assert.match(sankeySlide, /<p:grpSp>/);
  assert.match(sankeySlide, /sankey-link-1/);
  assert.doesNotMatch(sankeySlide, /<c:chart/);
});

test("keeps zero-weight treemap and sunburst nodes degenerate in SVG and editable PPTX", () => {
  const chart = (type, id, rows) => ({
    elementId: id,
    elementType: "chart",
    bounds: [0, 0, 400, 240],
    data: { cols: ["name", "value"], rows },
    series: [{ type, encode: { category: "name", value: "value" }, fill: ["#EF4444", "#2563EB"], dataLabels: false }],
  });
  const mixedTreemap = chart("treemap", "zero-tree", [["positive", 1], ["zero", 0]]);
  const mixedSunburst = chart("sunburst", "zero-sun", [["positive", 1], ["zero", 0]]);
  const treemapSvg = renderPageSvg({ elements: [mixedTreemap] }, { size: [400, 240] });
  const zeroRect = treemapSvg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#2563EB"/);
  assert.ok(zeroRect);
  assert.equal(Number(zeroRect[3]), 0);
  assert.equal(Number(zeroRect[1]), 400);

  const sunburstSvg = renderPageSvg({ elements: [mixedSunburst] }, { size: [400, 240] });
  const zeroPath = sunburstSvg.match(/<path d="([^"]+)" fill="#2563EB"/)?.[1] ?? "";
  const zeroArc = zeroPath.match(/^M\s+(\S+)\s+(\S+)\s+L\s+(\S+)\s+(\S+)\s+A\s+\S+\s+\S+\s+0\s+[01]\s+[01]\s+(\S+)\s+(\S+)\s+Z$/);
  assert.ok(zeroArc);
  assert.ok(Math.hypot(Number(zeroArc[3]) - Number(zeroArc[5]), Number(zeroArc[4]) - Number(zeroArc[6])) < 1e-9);

  const allZeroSvg = renderPageSvg({ elements: [chart("treemap", "empty-tree", [["A", 0], ["B", 0]])] }, { size: [400, 240] });
  const emptyWidths = [...allZeroSvg.matchAll(/<rect [^>]*width="([^"]+)"[^>]*fill="#(?:EF4444|2563EB)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(emptyWidths, [200, 200]);

  const root = mkdtempSync(join(tmpdir(), "pptx-zero-hierarchy-"));
  const project = { root, manifestPath: "deck.pptd", title: "Zero hierarchy", size: [400, 240], manifest: { version: "v2", title: "Zero hierarchy", size: [400, 240], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: { elements: [mixedTreemap] } }, { path: "pages/02.page", absolutePath: join(root, "02.page"), data: { elements: [mixedSunburst] } }] };
  const output = join(root, "zero-hierarchy.pptx"); exportPptx(project, output);
  const treemapSlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  const sunburstSlide = execFileSync("unzip", ["-p", output, "ppt/slides/slide2.xml"], { encoding: "utf8" });
  assert.match(treemapSlide, /name="zero-tree-node-2"[\s\S]*?<a:ext cx="0" cy="2171700"\/>/);
  const zeroSunShape = sunburstSlide.match(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="zero-sun-node-2"[\s\S]*?<\/p:sp>/)?.[0] ?? "";
  assert.match(zeroSunShape, /<a:custGeom>/);
  assert.match(zeroSunShape, /<a:moveTo>[\s\S]*?<a:lnTo>[\s\S]*?<a:close\/>/);
  assert.doesNotMatch(zeroSunShape, /<a:cubicBezTo>/);
  for (const slide of [treemapSlide, sunburstSlide]) assert.doesNotMatch(slide, /<c:chart/);
});

test("maps every PPTD animation effect into native PowerPoint timing behaviors", () => {
  const root = mkdtempSync(join(tmpdir(), "pptx-animations-"));
  const effects = ["appear", "fade-in", "fly-in", "zoom-in", "wipe-in", "float-in", "peek-in", "rise-in", "pulse", "grow-shrink", "spin", "teeter", "fill-color", "transparency", "color-pulse", "disappear", "fade-out", "fly-out", "zoom-out", "wipe-out", "float-out", "motion-path"];
  const elements = effects.map((effect, index) => ({ elementId: `element-${index}`, elementType: "shape", shapeName: "rect", bounds: [index * 4, index * 3, 20, 20], fill: "#2563EB" }));
  const animations = effects.map((effect, index) => ({ elementId: `element-${index}`, effect, trigger: ["onClick", "withPrevious", "afterPrevious"][index % 3], direction: index % 2 ? "down" : "up", durationMs: 300 + index, delayMs: index, repeat: index === 8 ? 2 : 1, easing: ["linear", "ease-in", "ease-out", "ease-in-out"][index % 4], ...(effect === "motion-path" ? { path: "M 0 0 C 100 0 100 50 200 50" } : {}), ...(["fill-color", "color-pulse"].includes(effect) ? { color: "#EF4444" } : {}), ...(effect === "transparency" ? { amount: .3 } : {}) }));
  const project = { root, manifestPath: "deck.pptd", title: "Animations", size: [960, 540], manifest: { version: "v2", title: "Animations", size: [960, 540], theme: {} }, pages: [{ path: "pages/01.page", absolutePath: join(root, "01.page"), data: { elements, animations } }] };
  const output = join(root, "animations.pptx"); exportPptx(project, output);
  const xml = execFileSync("unzip", ["-p", output, "ppt/slides/slide1.xml"], { encoding: "utf8" });
  assert.match(xml, /<p:timing>/);
  assert.match(xml, /nodeType="clickEffect"/);
  assert.match(xml, /nodeType="withEffect"/);
  assert.match(xml, /nodeType="afterEffect"/);
  assert.match(xml, /<p:set>/);
  assert.match(xml, /<p:animEffect transition="in" filter="fade">/);
  assert.match(xml, /<p:animScale>/);
  assert.match(xml, /<p:animRot by="21600000">/);
  assert.match(xml, /<p:animClr clrSpc="rgb">/);
  assert.match(xml, /<p:anim calcmode="lin" valueType="num">/);
  assert.match(xml, /<p:animMotion origin="layout" path="M 0\.000000 0\.000000 C /);
  assert.match(xml, /repeatCount="2000"/);
  assert.match(xml, /accel="100000"/);
});
