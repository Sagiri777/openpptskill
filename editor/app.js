import { assertWritableChangePath, basename, dirname, extractPagePaths, joinDeckPath, normalizeRelativePath, parseYaml, patchYamlSource, renderPageSvg, stringifyYaml, titleFromManifest } from "./lib.js";

const $ = (selector) => document.querySelector(selector);
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const ui = { open: $("#open-folder"), demo: $("#open-demo"), undo: $("#undo"), redo: $("#redo"), play: $("#play"), export: $("#export"), title: $("#document-title"), path: $("#document-path"), status: $("#connection-status"), statusLabel: $("#connection-label"), save: $("#save-state"), list: $("#slide-list"), count: $("#page-count"), canvas: $("#canvas"), selection: $("#selection-label"), inspector: $("#inspector-body"), layers: $("#layer-list"), dialog: $("#open-dialog"), choose: $("#choose-writable-folder"), upload: $("#upload-folder"), fallback: $("#folder-fallback"), activity: $("#activity-panel"), activityList: $("#activity-list"), toast: $("#toast-region") };
const state = { project: null, selectedPage: 0, selectedElement: null, directory: null, files: new Map(), readOnly: false, undo: [], redo: [], zoom: 1, playing: false, memory: new Map(), playback: { handles: [], timer: null, token: 0 } };
const ANIMATION_DURATIONS = { appear: 1, disappear: 1, pulse: 600, teeter: 1000, "rise-in": 1000, "grow-shrink": 2000, spin: 2000, "fill-color": 2000, transparency: 2000, "color-pulse": 2000, "motion-path": 2000 };

function toast(message, tone = "info") { const node = document.createElement("div"); node.className = `toast ${tone}`; node.textContent = message; ui.toast.append(node); setTimeout(() => node.remove(), 3200); }
function activity(message) { const node = document.createElement("li"); node.textContent = `${new Date().toLocaleTimeString("zh-CN")}  ${message}`; ui.activityList.prepend(node); while (ui.activityList.children.length > 30) ui.activityList.lastElementChild.remove(); }
function setSave(label, kind = "idle") { ui.save.textContent = label; ui.save.dataset.kind = kind; }
function setActivityOpen(open) { ui.activity.classList.toggle("is-open", open); ui.activity.setAttribute("aria-hidden", String(!open)); }
function escape(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function demoProject() {
  const manifest = { version: "v2", title: "NeoDeck Local", size: [960, 540], theme: { colors: { primary: "#d84f3f", ink: "#1f2937", muted: "#697586" } }, pages: ["pages/01.page", "pages/02.page"] };
  const pages = [
    {
      path: "pages/01.page",
      data: {
        pageType: "content",
        background: { type: "solid", color: "#f7f8fa" },
        elements: [
          { elementId: "eyebrow", elementType: "text", bounds: [80, 80, 700, 30], content: { fontSize: 16, color: "$primary", bold: true, text: "NEODECK LOCAL" } },
          { elementId: "title", elementType: "text", bounds: [80, 140, 760, 110], content: { fontSize: 48, color: "$ink", bold: true, text: "完全本地的 PPTD 工作台" } },
          { elementId: "body", elementType: "text", bounds: [82, 290, 650, 70], content: { fontSize: 20, color: "$muted", lineHeight: 1.5, text: "解析、编辑、渲染与 PPTX 导出都在你的设备上完成。" } },
          { elementId: "accent", elementType: "shape", bounds: [82, 400, 120, 8], shapeName: "roundRect", fill: { type: "solid", color: "$primary" } },
        ],
        animations: [
          { elementId: "eyebrow", effect: "fade-in", trigger: "withPrevious", durationMs: 350, easing: "ease-out" },
          { elementId: "title", effect: "fly-in", direction: "up", trigger: "afterPrevious", durationMs: 600, easing: "ease-out" },
          { elementId: "body", effect: "fade-in", trigger: "withPrevious", delayMs: 120, durationMs: 450, easing: "ease-out" },
          { elementId: "accent", effect: "wipe-in", direction: "right", trigger: "afterPrevious", durationMs: 400, easing: "ease-out" },
        ],
      },
    },
    {
      path: "pages/02.page",
      data: {
        pageType: "content",
        background: { type: "solid", color: "#1f2937" },
        elements: [
          { elementId: "title", elementType: "text", bounds: [80, 110, 760, 80], content: { fontSize: 42, color: "#ffffff", bold: true, text: "你的文件仍然是普通 YAML" } },
          { elementId: "body", elementType: "text", bounds: [82, 230, 700, 120], content: { fontSize: 20, color: "#d6dce5", lineHeight: 1.6, text: "页面、图片、表格、图表和动画均可继续交给其他工具处理。" } },
        ],
        animations: [
          { elementId: "title", effect: "zoom-in", trigger: "afterPrevious", durationMs: 500, easing: "ease-out" },
          { elementId: "body", effect: "float-in", direction: "up", trigger: "afterPrevious", durationMs: 500, easing: "ease-out" },
        ],
      },
    },
  ];
  return { root: "", manifestPath: "presentation.pptd", manifestSource: stringifyYaml(manifest), manifest, pages, size: manifest.size, title: manifest.title };
}

function snapshot() { return JSON.stringify(state.project?.pages.map((page) => ({ path: page.path, source: page.source ?? "", data: page.data })) ?? []); }
function pushUndo() { if (!state.project) return; state.undo.push(snapshot()); if (state.undo.length > 50) state.undo.shift(); state.redo = []; updateHistoryButtons(); }
function restore(serialized) { const pages = JSON.parse(serialized); if (!state.project) return; const beforeManifest = structuredClone(state.project.manifest); state.project.pages = pages; state.project.manifest.pages = pages.map((page) => page.path); state.project.manifestSource = patchYamlSource(state.project.manifestSource, beforeManifest, state.project.manifest); state.selectedPage = Math.min(state.selectedPage, pages.length - 1); state.selectedElement = null; renderAll(); setSave("有未保存修改", "dirty"); }
function updateHistoryButtons() { ui.undo.disabled = !state.undo.length; ui.redo.disabled = !state.redo.length; }
function undo() { if (!state.undo.length) return; state.redo.push(snapshot()); restore(state.undo.pop()); updateHistoryButtons(); activity("已撤销"); }
function redo() { if (!state.redo.length) return; state.undo.push(snapshot()); restore(state.redo.pop()); updateHistoryButtons(); activity("已重做"); }

function resourceResolver(requested) { if (!requested || /^https?:\/\//i.test(requested)) return ""; const path = resolveIndexedPath(requested); const entry = state.files.get(path); if (!entry) return ""; if (entry.dataUrl) return entry.dataUrl; return ""; }
function resolveIndexedPath(requested) { let value = String(requested).replace(/^file:\/\/+/, "").replaceAll("\\", "/"); try { value = decodeURIComponent(value); } catch {} const candidates = []; const root = state.project?.root ?? dirname(state.project?.manifestPath ?? ""); try { if (root) candidates.push(joinDeckPath(root, value)); } catch {} try { candidates.push(normalizeRelativePath(value)); } catch {} for (const candidate of candidates) if (state.files.has(candidate)) return candidate; if (root) { const prefix = `${root}/`; for (const path of state.files.keys()) if (path.startsWith(prefix) && candidates.includes(path)) return path; } for (const path of state.files.keys()) if (candidates.some((candidate) => path === candidate || path.endsWith(`/${candidate}`))) return path; return candidates[0] ?? value; }
function pageData() { return state.project?.pages[state.selectedPage]?.data; }

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function animationDuration(animation) {
  if (animation.effect === "appear" || animation.effect === "disappear") return 1;
  return Math.max(1, finiteNumber(animation.durationMs, ANIMATION_DURATIONS[animation.effect] ?? 500));
}

function buildAnimationTimeline(page) {
  let previousStart = 0;
  let previousEnd = 0;
  let sequenceEnd = 0;
  return (Array.isArray(page?.animations) ? page.animations : []).map((animation, index) => {
    const duration = animationDuration(animation);
    const repeatValue = finiteNumber(animation.repeat, 1);
    const repeat = Number.isInteger(repeatValue) && repeatValue > 0 ? repeatValue : 1;
    const delay = Math.max(0, finiteNumber(animation.delayMs, 0));
    const trigger = animation.trigger ?? "onClick";
    let start = delay;
    if (index > 0 && trigger === "withPrevious") start = previousStart + delay;
    else if (index > 0 && trigger === "afterPrevious") start = previousEnd + delay;
    else if (index > 0) start = sequenceEnd + delay;
    const end = start + duration * repeat;
    previousStart = start;
    previousEnd = end;
    sequenceEnd = Math.max(sequenceEnd, end);
    return { animation, duration, repeat, start, end };
  });
}

function travelVector(direction, bounds, size, outgoing = false, mode = "page") {
  const [x = 0, y = 0, width = 0, height = 0] = bounds ?? [];
  const [pageWidth = 960, pageHeight = 540] = size ?? [];
  const value = direction ?? "up";
  if (mode === "float") {
    const distance = Math.max(24, pageHeight * 0.1);
    return value === "down" ? [0, outgoing ? distance : -distance] : [0, outgoing ? -distance : distance];
  }
  if (mode === "peek") {
    if (value === "down") return [0, -Math.max(1, height)];
    if (value === "left") return [Math.max(1, width), 0];
    if (value === "right") return [-Math.max(1, width), 0];
    return [0, Math.max(1, height)];
  }
  const margin = 24;
  if (outgoing) {
    if (value === "down") return [0, pageHeight - y + margin];
    if (value === "left") return [-(x + width + margin), 0];
    if (value === "right") return [pageWidth - x + margin, 0];
    return [0, -(y + height + margin)];
  }
  if (value === "down") return [0, -(y + height + margin)];
  if (value === "left") return [pageWidth - x + margin, 0];
  if (value === "right") return [-(x + width + margin), 0];
  return [0, pageHeight - y + margin];
}

function translate([x, y]) {
  return `translate(${x}px, ${y}px)`;
}

function hiddenInset(direction) {
  if (direction === "down") return "inset(0% 0% 100% 0%)";
  if (direction === "left") return "inset(0% 0% 0% 100%)";
  if (direction === "right") return "inset(0% 100% 0% 0%)";
  return "inset(100% 0% 0% 0%)";
}

function motionPathKeyframes(path) {
  const root = ui.canvas.querySelector("svg");
  if (!root || !path) return [{ transform: "translate(0px, 0px)" }, { transform: "translate(0px, 0px)" }];
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "path");
  probe.setAttribute("d", String(path));
  probe.setAttribute("visibility", "hidden");
  probe.setAttribute("pointer-events", "none");
  root.append(probe);
  try {
    const length = probe.getTotalLength();
    if (!Number.isFinite(length) || length <= 0) return [{ transform: "translate(0px, 0px)" }, { transform: "translate(0px, 0px)" }];
    const samples = Math.max(12, Math.min(60, Math.ceil(length / 20)));
    return Array.from({ length: samples + 1 }, (_, index) => {
      const offset = index / samples;
      const point = probe.getPointAtLength(length * offset);
      return { offset, transform: `translate(${point.x}px, ${point.y}px)` };
    });
  } catch {
    return [{ transform: "translate(0px, 0px)" }, { transform: "translate(0px, 0px)" }];
  } finally {
    probe.remove();
  }
}

function paintAnimationPlans(animation, target) {
  const color = String(animation.color ?? "");
  if (!/^[#]?[0-9a-f]{6}$/i.test(color)) return [];
  const destination = color.startsWith("#") ? color : `#${color}`;
  const nodes = [...target.querySelectorAll("[fill]")].filter((node) => node.getAttribute("fill") !== "none");
  return nodes.map((node) => {
    const source = getComputedStyle(node).fill || node.getAttribute("fill") || destination;
    const keyframes = animation.effect === "color-pulse"
      ? [{ fill: source }, { fill: destination }, { fill: source }]
      : [{ fill: source }, { fill: destination }];
    return { node, keyframes, fill: "forwards" };
  });
}

function animationPlans(animation, target, element, size) {
  const effect = animation.effect;
  const bounds = element?.bounds ?? [0, 0, 0, 0];
  const finalFrame = { opacity: 1, transform: "translate(0px, 0px) scale(1) rotate(0deg)" };
  target.style.transformBox = "fill-box";
  target.style.transformOrigin = "center";
  if (effect === "fill-color" || effect === "color-pulse") return paintAnimationPlans(animation, target);
  if (effect === "appear") return [{ node: target, keyframes: [{ opacity: 0 }, { opacity: 1 }], fill: "both" }];
  if (effect === "fade-in") return [{ node: target, keyframes: [{ opacity: 0 }, { opacity: 1 }], fill: "both" }];
  if (effect === "fly-in") return [{ node: target, keyframes: [{ opacity: 0, transform: translate(travelVector(animation.direction, bounds, size)) }, finalFrame], fill: "both" }];
  if (effect === "zoom-in") return [{ node: target, keyframes: [{ opacity: 0, transform: "scale(0.2)" }, { opacity: 1, transform: "scale(1)" }], fill: "both" }];
  if (effect === "wipe-in") return [{ node: target, keyframes: [{ clipPath: hiddenInset(animation.direction) }, { clipPath: "inset(0% 0% 0% 0%)" }], fill: "both" }];
  if (effect === "float-in") return [{ node: target, keyframes: [{ opacity: 0, transform: translate(travelVector(animation.direction, bounds, size, false, "float")) }, finalFrame], fill: "both" }];
  if (effect === "peek-in") return [{ node: target, keyframes: [{ transform: translate(travelVector(animation.direction, bounds, size, false, "peek")), clipPath: hiddenInset(animation.direction) }, { transform: "translate(0px, 0px)", clipPath: "inset(0% 0% 0% 0%)" }], fill: "both" }];
  if (effect === "rise-in") return [{ node: target, keyframes: [{ transform: translate(travelVector("up", bounds, size)) }, { transform: "translate(0px, 0px)" }], fill: "both" }];
  if (effect === "pulse") return [{ node: target, keyframes: [{ transform: "scale(1)" }, { transform: "scale(1.1)" }, { transform: "scale(1)" }], fill: "forwards" }];
  if (effect === "grow-shrink") return [{ node: target, keyframes: [{ transform: "scale(1)" }, { transform: "scale(1.5)" }, { transform: "scale(1)" }], fill: "forwards" }];
  if (effect === "spin") return [{ node: target, keyframes: [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], fill: "forwards" }];
  if (effect === "teeter") return [{ node: target, keyframes: [{ transform: "rotate(0deg)" }, { transform: "rotate(-5deg)" }, { transform: "rotate(5deg)" }, { transform: "rotate(-5deg)" }, { transform: "rotate(5deg)" }, { transform: "rotate(0deg)" }], fill: "forwards" }];
  if (effect === "transparency") {
    const opacity = Math.max(0, Math.min(1, finiteNumber(animation.amount, 1)));
    return [{ node: target, keyframes: [{ opacity: finiteNumber(getComputedStyle(target).opacity, 1) }, { opacity }], fill: "forwards" }];
  }
  if (effect === "disappear") return [{ node: target, keyframes: [{ opacity: 1 }, { opacity: 0 }], fill: "forwards" }];
  if (effect === "fade-out") return [{ node: target, keyframes: [{ opacity: 1 }, { opacity: 0 }], fill: "forwards" }];
  if (effect === "fly-out") return [{ node: target, keyframes: [finalFrame, { opacity: 0, transform: translate(travelVector(animation.direction, bounds, size, true)) }], fill: "forwards" }];
  if (effect === "zoom-out") return [{ node: target, keyframes: [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.2)" }], fill: "forwards" }];
  if (effect === "wipe-out") return [{ node: target, keyframes: [{ clipPath: "inset(0% 0% 0% 0%)" }, { clipPath: hiddenInset(animation.direction) }], fill: "forwards" }];
  if (effect === "float-out") return [{ node: target, keyframes: [finalFrame, { opacity: 0, transform: translate(travelVector(animation.direction, bounds, size, true, "float")) }], fill: "forwards" }];
  if (effect === "motion-path") return [{ node: target, keyframes: motionPathKeyframes(animation.path), fill: "forwards" }];
  return [];
}

function updatePlayButton() {
  ui.play.textContent = state.playing ? "❚❚" : "▶";
  ui.play.title = state.playing ? "停止播放" : "播放动画";
  ui.play.setAttribute("aria-label", ui.play.title);
  ui.play.setAttribute("aria-pressed", String(state.playing));
  ui.play.classList.toggle("is-playing", state.playing);
  ui.canvas.classList.toggle("playing", state.playing);
}

function resetPlayback({ announce = false } = {}) {
  const wasPlaying = state.playing;
  state.playback.token += 1;
  if (state.playback.timer != null) clearTimeout(state.playback.timer);
  state.playback.timer = null;
  for (const handle of state.playback.handles) {
    try { handle.cancel(); } catch {}
  }
  state.playback.handles = [];
  state.playing = false;
  updatePlayButton();
  if (announce && wasPlaying) activity("已停止当前页动画");
}

function finishPlayback(token) {
  if (token !== state.playback.token) return;
  state.playback.timer = null;
  state.playing = false;
  updatePlayButton();
  activity("当前页动画播放完成");
}

function startPlayback() {
  const page = pageData();
  const definitions = Array.isArray(page?.animations) ? page.animations : [];
  resetPlayback();
  if (!definitions.length) {
    toast("当前页面没有可播放的动画");
    return;
  }
  const targetNodes = new Map();
  for (const node of ui.canvas.querySelectorAll("[data-element-id]")) if (!targetNodes.has(node.dataset.elementId)) targetNodes.set(node.dataset.elementId, node);
  const elements = new Map((page.elements ?? []).filter((element) => element.elementId != null).map((element) => [String(element.elementId), element]));
  const timeline = buildAnimationTimeline(page);
  const token = state.playback.token;
  let totalDuration = 0;
  let playableCount = 0;
  for (const entry of timeline) {
    const target = targetNodes.get(String(entry.animation.elementId));
    if (!target) continue;
    const plans = animationPlans(entry.animation, target, elements.get(String(entry.animation.elementId)), state.project.size);
    for (const plan of plans) {
      try {
        const handle = plan.node.animate(plan.keyframes, {
          duration: entry.duration,
          delay: entry.start,
          iterations: entry.repeat,
          easing: ["linear", "ease-in", "ease-out", "ease-in-out"].includes(entry.animation.easing) ? entry.animation.easing : "linear",
          fill: plan.fill,
        });
        state.playback.handles.push(handle);
        playableCount += 1;
      } catch {}
    }
    if (plans.length) totalDuration = Math.max(totalDuration, entry.end);
  }
  if (!playableCount) {
    resetPlayback();
    toast("当前页面的动画没有匹配到可播放元素", "error");
    return;
  }
  state.playing = true;
  updatePlayButton();
  activity(`开始播放当前页动画（${definitions.length} 项）`);
  state.playback.timer = setTimeout(() => finishPlayback(token), Math.ceil(totalDuration) + 50);
}

function renderAll() { if (!state.project) return; ui.title.textContent = state.project.title; ui.path.textContent = state.project.manifestPath || "内置示例"; ui.count.textContent = String(state.project.pages.length); if (state.selectedElement == null) { ui.selection.textContent = "未选择"; ui.inspector.innerHTML = '<p class="empty-state">从左侧选择页面，再选择一个元素。</p>'; } renderSlides(); renderCanvas(); renderLayers(); updateHistoryButtons(); }
function renderSlides() { ui.list.replaceChildren(); state.project.pages.forEach((page, index) => { const button = document.createElement("button"); button.type = "button"; button.className = `slide-thumb ${index === state.selectedPage ? "is-active" : ""}`; button.innerHTML = `<div class="thumb-image"></div><small>${String(index + 1).padStart(2, "0")} · ${escape(page.path)}</small>`; button.querySelector(".thumb-image").innerHTML = renderPageSvg(page.data, { size: state.project.size, theme: state.project.manifest.theme, resourceResolver }); button.addEventListener("click", () => { state.selectedPage = index; state.selectedElement = null; renderAll(); }); ui.list.append(button); }); }
function renderCanvas() {
  resetPlayback();
  const page = pageData();
  if (!page) return;

  ui.canvas.innerHTML = renderPageSvg(page, {
    size: state.project.size,
    theme: state.project.manifest.theme,
    resourceResolver,
    includeElementMetadata: true,
  });

  const frame = ui.canvas.closest("#canvas-frame");
  const scroll = frame?.parentElement;
  if (!frame || !scroll) return;

  // Fit the initial view to the usable scroll viewport. The old calculation
  // used the whole canvas-area width and let the slide run under the inspector.
  const styles = getComputedStyle(scroll);
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const availableWidth = Math.max(1, scroll.clientWidth - horizontalPadding);
  const availableHeight = Math.max(1, scroll.clientHeight - verticalPadding);
  const fitScale = Math.min(
    availableWidth / state.project.size[0],
    availableHeight / state.project.size[1],
  );
  // A zoom value at or below 100% starts from a fitted slide. Values above
  // 100% remain larger than the viewport and can be inspected by scrolling.
  const displayScale = state.zoom <= 1 ? Math.min(state.zoom, fitScale) : state.zoom;
  frame.style.width = `${state.project.size[0] * displayScale}px`;
  frame.style.height = `${state.project.size[1] * displayScale}px`;
  frame.dataset.scale = String(displayScale);
  scroll.classList.toggle("is-zoomed", displayScale > fitScale + 0.001);
}
function renderLayers() { ui.layers.replaceChildren(); for (let index = (pageData()?.elements?.length ?? 0) - 1; index >= 0; index -= 1) { const element = pageData().elements[index]; const item = document.createElement("li"); item.textContent = element.elementId || `${element.elementType || "元素"} ${index + 1}`; item.className = state.selectedElement === index ? "is-active" : ""; item.addEventListener("click", () => selectElement(index)); ui.layers.append(item); } }
function selectElement(index) { state.selectedElement = index; const element = pageData()?.elements?.[index]; if (!element) return; ui.selection.textContent = element.elementId || element.elementType || "元素"; const content = element.content ?? {}; ui.inspector.innerHTML = `<div class="field"><label>元素 ID</label><input id="element-id" value="${escape(element.elementId || "")}" /></div><div class="field"><label>位置与尺寸（x, y, width, height）</label><input id="element-bounds" value="${escape((element.bounds || []).join(", "))}" /></div><div class="field"><label>文本 / 内容</label><textarea id="element-text">${escape(content.text ?? element.text ?? "")}</textarea></div><button class="apply-button" id="apply-element" type="button">应用修改</button>`; $("#apply-element").addEventListener("click", () => { const nextId = $("#element-id").value.trim(); const nextBounds = $("#element-bounds").value.split(",").map(Number); const nextText = $("#element-text").value; applyChange(() => { element.elementId = nextId || element.elementId; if (nextBounds.length === 4 && nextBounds.every(Number.isFinite)) element.bounds = nextBounds; if (element.elementType === "text" || element.elementType === "formula") element.content = { ...(element.content || {}), text: nextText }; else if (element.text != null) element.text = nextText; }).then(() => { state.selectedElement = index; selectElement(index); activity(`已修改 ${element.elementId || "元素"}`); }).catch((error) => fail(error.message)); }); renderLayers(); }

async function indexDirectory(handle) { const map = new Map(); const walk = async (directory, prefix = "") => { for await (const [name, entry] of directory.entries()) { const path = prefix ? `${prefix}/${name}` : name; if (entry.kind === "directory") await walk(entry, path); else if (name !== ".DS_Store") map.set(normalizeRelativePath(path), entry); } }; await walk(handle); return map; }
function indexFallback(files) { const map = new Map(); const paths = [...files]; const root = paths[0]?.webkitRelativePath?.split("/")[0] || ""; for (const file of paths) { let path = file.webkitRelativePath || file.name; if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1); map.set(normalizeRelativePath(path), { kind: "file", getFile: async () => file }); } return map; }
async function hydrateImages() { for (const [path, entry] of state.files) { if (!/\.(?:png|jpe?g|gif|svg|webp|ttf|otf|woff2?)$/i.test(path)) continue; const file = await entry.getFile(); if (file.size > 20 * 1024 * 1024) continue; const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; const chunk = 0x8000; for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk)); const mime = file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" }[path.split(".").pop().toLowerCase()] || "application/octet-stream"); entry.dataUrl = `data:${mime};base64,${btoa(binary)}`; } }
async function readEntry(path) { const entry = state.files.get(normalizeRelativePath(path)); if (!entry) throw new Error(`找不到文件：${path}`); const file = await entry.getFile(); if (file.size > MAX_TEXT_BYTES) throw new Error(`文件过大，无法在浏览器中读取：${path}`); return file.text(); }
async function loadManifest(path, label) { const manifestSource = await readEntry(path); const manifest = parseYaml(manifestSource); const pagePaths = extractPagePaths(manifestSource); const root = dirname(path); const pages = []; for (const pagePath of pagePaths) { const full = joinDeckPath(root, pagePath); const source = await readEntry(full); pages.push({ path: pagePath, source, data: parseYaml(source) }); } state.project = { root, manifestPath: path, manifestSource, manifest, pages, size: manifest.size || [960, 540], title: titleFromManifest(manifestSource, basename(path).replace(/\.pptd$/i, "")) }; state.selectedPage = 0; state.selectedElement = null; ui.status.className = "status-pill"; ui.statusLabel.textContent = state.readOnly ? "只读模式" : "本地内核"; setSave(state.readOnly ? "只读打开" : "已保存", state.readOnly ? "readonly" : "saved"); renderAll(); activity(`已载入 ${state.project.title}，共 ${pages.length} 页`); }
async function openDirectory(handle, readOnly = false) { state.directory = readOnly ? null : handle; state.readOnly = readOnly; state.files = await indexDirectory(handle); await hydrateImages(); const manifests = [...state.files.keys()].filter((path) => path.toLowerCase().endsWith(".pptd")); if (!manifests.length) throw new Error("项目中没有 .pptd 清单"); await loadManifest(manifests.sort()[0], `${handle.name}/${manifests[0]}`); ui.dialog.close(); }
async function pickDirectory() { try { if ("showDirectoryPicker" in window) { const handle = await window.showDirectoryPicker({ mode: "readwrite" }); let permission = await handle.queryPermission?.({ mode: "readwrite" }); if (permission !== "granted") permission = await handle.requestPermission?.({ mode: "readwrite" }); await openDirectory(handle, permission !== "granted"); } else ui.fallback.click(); } catch (error) { if (error.name !== "AbortError") fail(error.message); } }
async function openFallback(files) { state.files = indexFallback(files); state.readOnly = true; await hydrateImages(); const manifests = [...state.files.keys()].filter((path) => path.toLowerCase().endsWith(".pptd")); if (!manifests.length) throw new Error("上传内容中没有 .pptd 清单"); await loadManifest(manifests.sort()[0], `${manifests[0]} · 只读`); ui.dialog.close(); }

async function writeFile(path, content) { if (state.readOnly || !state.directory) throw new Error("当前为只读模式，请使用 Chromium 授权项目目录"); const parts = normalizeRelativePath(path).split("/"); const name = parts.pop(); let directory = state.directory; for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true }); const handle = await directory.getFileHandle(name, { create: true }); const writable = await handle.createWritable(); await writable.write(content); await writable.close(); }
async function saveProject() { if (!state.project || state.readOnly) return; if (!state.directory) { setSave("示例 · 内存保存", "memory"); return; } setSave("保存中…", "saving"); await writeFile(state.project.manifestPath, state.project.manifestSource || stringifyYaml(state.project.manifest)); for (const page of state.project.pages) await writeFile(joinDeckPath(state.project.root, page.path), page.source || stringifyYaml(page.data)); setSave("刚刚已保存", "saved"); activity("已原子写入清单与页面"); }
async function applyChange(callback) { const beforeManifest = structuredClone(state.project.manifest); const beforePages = new Map(state.project.pages.map((page) => [page.path, { source: page.source, data: structuredClone(page.data) }])); pushUndo(); callback(); state.project.manifest.pages = state.project.pages.map((page) => page.path); state.project.manifestSource = patchYamlSource(state.project.manifestSource, beforeManifest, state.project.manifest); for (const page of state.project.pages) { const previous = beforePages.get(page.path); page.source = previous ? patchYamlSource(previous.source, previous.data, page.data) : stringifyYaml(page.data); } renderAll(); setSave(state.readOnly ? "只读修改" : "有未保存修改", state.readOnly ? "readonly" : "dirty"); if (!state.readOnly) await saveProject(); }
function nextPagePath() { const used = new Set(state.project.pages.map((page) => page.path)); let index = state.project.pages.length + 1; while (used.has(`pages/${String(index).padStart(2, "0")}.page`)) index += 1; return `pages/${String(index).padStart(2, "0")}.page`; }
function addPage() { if (!state.project) return; applyChange(() => { state.project.pages.push({ path: nextPagePath(), source: "", data: { pageType: "content", background: { type: "solid", color: "#ffffff" }, elements: [] } }); state.selectedPage = state.project.pages.length - 1; state.selectedElement = null; }).catch((error) => fail(error.message)); }
function duplicatePage() { if (!state.project) return; applyChange(() => { const page = state.project.pages[state.selectedPage]; state.project.pages.splice(state.selectedPage + 1, 0, { ...page, path: nextPagePath(), data: JSON.parse(JSON.stringify(page.data)) }); state.selectedPage += 1; state.selectedElement = null; }).catch((error) => fail(error.message)); }
function deletePage() { if (!state.project || state.project.pages.length < 2) return toast("至少保留一页", "error"); applyChange(() => { state.project.pages.splice(state.selectedPage, 1); state.selectedPage = Math.min(state.selectedPage, state.project.pages.length - 1); }).catch((error) => fail(error.message)); }
function fail(message) { activity(`错误：${message}`); toast(message, "error"); }
async function exportDeck() {
  if (!state.project) return;
  ui.export.disabled = true;
  try {
    const media = [...state.files].filter(([, entry]) => entry.dataUrl).map(([path, entry]) => ({ path, data: entry.dataUrl.slice(entry.dataUrl.indexOf(",") + 1) }));
    const payload = { project: { title: state.project.title, size: state.project.size, manifestPath: state.project.manifestPath, manifest: state.project.manifest, manifestSource: state.project.manifestSource || stringifyYaml(state.project.manifest), pages: state.project.pages.map((page) => ({ path: page.path, source: page.source || stringifyYaml(page.data), data: page.data })), media }, options: { transition: "fade" } };
    const response = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.project.title || "presentation"}.pptx`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); activity("已生成本地 PPTX"); toast("PPTX 已下载", "success");
  } catch (error) { fail(`导出失败：${error.message}`); } finally { ui.export.disabled = false; }
}

ui.open.addEventListener("click", () => ui.dialog.showModal());
ui.choose.addEventListener("click", pickDirectory);
ui.upload.addEventListener("click", () => ui.fallback.click());
ui.fallback.addEventListener("change", () => { if (ui.fallback.files?.length) openFallback(ui.fallback.files).catch((error) => fail(error.message)); ui.fallback.value = ""; });
ui.demo.addEventListener("click", () => { state.project = demoProject(); state.selectedPage = 0; state.selectedElement = null; state.readOnly = false; state.directory = null; setSave("示例 · 内存保存", "memory"); renderAll(); activity("已打开内置示例"); });
ui.undo.addEventListener("click", undo);
ui.redo.addEventListener("click", redo);
$("#add-page").addEventListener("click", addPage);
$("#duplicate-page").addEventListener("click", duplicatePage);
$("#delete-page").addEventListener("click", deletePage);
$("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(2, state.zoom + .1); $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`; renderCanvas(); });
$("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(.5, state.zoom - .1); $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`; renderCanvas(); });
$("#toggle-activity").addEventListener("click", () => setActivityOpen(!ui.activity.classList.contains("is-open")));
$("#close-activity").addEventListener("click", () => setActivityOpen(false));
ui.play.addEventListener("click", () => state.playing ? resetPlayback({ announce: true }) : startPlayback());
ui.export.addEventListener("click", exportDeck);
window.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveProject().catch((error) => fail(error.message)); } });
window.addEventListener("resize", () => { if (state.project) renderCanvas(); });
window.neoDeck = {
  openDemo: () => { ui.demo.click(); },
  play: startPlayback,
  stop: () => resetPlayback(),
  get status() {
    return {
      connected: true,
      source: state.readOnly ? "readonly" : state.directory ? "directory" : "demo",
      title: state.project?.title ?? "",
      manifestPath: state.project?.manifestPath ?? "",
      pages: state.project?.pages.length ?? 0,
      animations: pageData()?.animations?.length ?? 0,
      playing: state.playing,
      saveState: ui.save.dataset.kind,
    };
  },
};
ui.demo.click();
