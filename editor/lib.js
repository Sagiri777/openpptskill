import {
  latexToOmml,
  parseYaml,
  parseYamlCst,
  PRESET_SHAPE_NAMES,
  renderPageSvg,
  resolveColor,
  SHAPE_ADJUSTMENTS,
  SHAPE_ADJUSTMENT_NAMES,
  stringifyYaml,
  stringifyYamlCst,
  updateYamlCst,
} from "../lib/pptd-core.js";

export {
  latexToOmml,
  parseYaml,
  parseYamlCst,
  PRESET_SHAPE_NAMES,
  renderPageSvg,
  resolveColor,
  SHAPE_ADJUSTMENTS,
  SHAPE_ADJUSTMENT_NAMES,
  stringifyYaml,
  stringifyYamlCst,
  updateYamlCst,
};

export function normalizeRelativePath(path) {
  const value = String(path ?? "").replaceAll("\\", "/");
  if (!value || /^(?:[a-z]+:|\/|[A-Za-z]:\/)/i.test(value)) throw new Error(`不允许绝对路径：${value}`);
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`不允许越过项目目录：${value}`);
    parts.push(part);
  }
  if (!parts.length) throw new Error(`无效文件路径：${value}`);
  return parts.join("/");
}

export function dirname(path) {
  const value = normalizeRelativePath(path);
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

export function basename(path) {
  const value = normalizeRelativePath(path);
  return value.slice(value.lastIndexOf("/") + 1);
}

export function joinDeckPath(base, path) {
  const child = normalizeRelativePath(path);
  if (!base) return child;
  const parent = normalizeRelativePath(base);
  return child === parent || child.startsWith(`${parent}/`) ? child : normalizeRelativePath(`${parent}/${child}`);
}

export function assertWritableChangePath(base, requestedPath) {
  const path = joinDeckPath(base, requestedPath);
  if (!/\.(?:pptd|page)$/i.test(path)) throw new Error(`仅允许编辑 .pptd/.page：${requestedPath}`);
  return path;
}

export function patchYamlSource(source, before, after) {
  if (!source) return stringifyYaml(after);
  const document = parseYamlCst(source);
  // The source is authoritative; `before` is accepted for API compatibility
  // and lets callers keep their existing immutable-edit workflow.
  if (before && typeof before === "object") document.value = structuredClone(before);
  updateYamlCst(document, after);
  return stringifyYamlCst(document);
}

export function extractPagePaths(source) {
  const data = parseYaml(source);
  if (!Array.isArray(data?.pages)) throw new Error("PPTD manifest 缺少 pages 列表");
  return data.pages.map((path) => normalizeRelativePath(String(path)));
}

export function titleFromManifest(source, fallback) {
  try {
    return String(parseYaml(source)?.title || fallback);
  } catch {
    return fallback;
  }
}
