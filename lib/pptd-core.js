/*
 * Local PPTD runtime.
 *
 * The package intentionally has no runtime dependency on a browser service or
 * on a YAML/OOXML package.  This module contains the small YAML 1.2 subset
 * used by PPTD, a deterministic SVG renderer, and a standards-compliant
 * (albeit deliberately conservative) OOXML writer.  Unknown PPTD fields are
 * retained on the parsed objects, so callers can round-trip documents without
 * silently dropping newer fields.
 */
// The parser and renderer are also loaded directly by the browser editor. Keep
// Node-only modules behind a runtime branch so the same file can be shared
// without a bundler or a second, drifting implementation.
const nodeRuntime = typeof process !== "undefined" && Boolean(process.versions?.node);
const [cryptoModule, fsModule, pathModule, zlibModule] = nodeRuntime
  ? await Promise.all([import("node:crypto"), import("node:fs"), import("node:path"), import("node:zlib")])
  : [{}, {}, {}, {}];
const { createHash } = cryptoModule;
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = fsModule;
const { basename, extname, posix, relative, resolve } = pathModule;
const { deflateRawSync } = zlibModule;
import { ECMA_PRESET_GEOMETRIES } from "./preset-geometries.js";

const EMU_PER_PX = 9525;
const XML_NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};

function fail(message, line) {
  const suffix = line == null ? "" : ` (line ${line + 1})`;
  throw new Error(`${message}${suffix}`);
}

function stripComment(value) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#" && depth === 0 && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}

function splitInline(value, separator = ",") {
  const parts = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function findMappingColon(value) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0 && (i + 1 === value.length || /\s/.test(value[i + 1]))) return i;
  }
  return -1;
}

function findFlowMappingColon(value) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

function yamlKey(value, line) {
  const text = String(value ?? "").trim();
  if (!text) fail("YAML 映射键不能为空", line);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return String(parseScalar(text, line) ?? "");
  return text;
}

function parseScalar(value, line) {
  const text = stripComment(value).trim();
  if (!text) return null;
  if (/^(?:null|~)$/i.test(text)) return null;
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true";
  const numeric = text.replaceAll("_", "");
  if (/^[+-]?0x[0-9a-f]+$/i.test(numeric)) return Number.parseInt(numeric, 16);
  if (/^[+-]?0o[0-7]+$/i.test(numeric)) return Number.parseInt(numeric, 8);
  if (/^[+-]?0b[01]+$/i.test(numeric)) return Number.parseInt(numeric, 2);
  if (/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(numeric)) return Number(numeric);
  if (/^[+-]?(?:\.inf|\.nan)$/i.test(text)) return text.toLowerCase().includes("nan") ? Number.NaN : text.startsWith("-") ? -Infinity : Infinity;
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch { /* fall through to a useful YAML error */ }
    fail("无效的双引号字符串", line);
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]")) return splitInline(text.slice(1, -1)).map((part) => parseScalar(part, line));
  if (text.startsWith("{") && text.endsWith("}")) {
    const object = {};
    for (const part of splitInline(text.slice(1, -1))) {
      const colon = findFlowMappingColon(part);
      if (colon === -1) fail(`无效的内联映射：${part}`, line);
      const key = yamlKey(part.slice(0, colon), line);
      object[key] = parseScalar(part.slice(colon + 1), line);
    }
    return object;
  }
  return text;
}

function significantLines(source) {
  const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.split("\n").map((raw, index) => {
    if (/^ *\t/.test(raw)) fail("YAML 缩进不能使用 Tab", index);
    const match = raw.match(/^( *)/);
    const text = raw.slice(match[1].length);
    const marker = match[1].length === 0 && (text.trim() === "---" || text.trim() === "...");
    return { raw, indent: match[1].length, text: marker ? "" : text, line: index };
  });
}

function isBlockScalar(value) {
  return /^[|>](?:[1-9][+-]?|[+-][1-9]?|[+-]?)?$/.test(String(value ?? "").trim());
}

function readBlockScalar(lines, cursor, parentIndent, indicator) {
  const header = String(indicator ?? "|").trim();
  const folded = header[0] === ">";
  const suffix = header.slice(1);
  const explicitIndent = Number(suffix.match(/[1-9]/)?.[0] ?? 0);
  const chomping = suffix.includes("-") ? "-" : suffix.includes("+") ? "+" : "clip";
  let contentIndent = null;
  for (let index = cursor.index; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim()) continue;
    if (line.indent <= parentIndent) break;
    contentIndent = explicitIndent ? parentIndent + explicitIndent : line.indent;
    break;
  }
  if (contentIndent == null && explicitIndent) contentIndent = parentIndent + explicitIndent;
  const blockLines = [];
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line.text.trim() && (contentIndent == null || line.indent < contentIndent)) break;
    blockLines.push(line);
    cursor.index += 1;
  }
  const block = blockLines.map((line) => {
    if (!line.text.trim()) return "";
    return line.raw.slice(Math.min(line.raw.length, contentIndent ?? parentIndent + 2));
  });
  let value = "";
  if (folded) {
    let previousTextIndex = -1;
    for (let index = 0; index < block.length; index += 1) {
      if (!block[index]) continue;
      if (previousTextIndex < 0) value = `${"\n".repeat(index)}${block[index]}`;
      else {
        const emptyLines = index - previousTextIndex - 1;
        const baseIndent = contentIndent ?? parentIndent + 2;
        const preservesBreaks = blockLines[previousTextIndex].indent > baseIndent || blockLines[index].indent > baseIndent;
        const separator = emptyLines ? "\n".repeat(emptyLines + (preservesBreaks ? 1 : 0)) : preservesBreaks ? "\n" : " ";
        value += `${separator}${block[index]}`;
      }
      previousTextIndex = index;
    }
    if (previousTextIndex < 0) value = "\n".repeat(block.length);
    else value += "\n".repeat(block.length - previousTextIndex - 1);
  } else value = block.join("\n");
  if (chomping === "-") return value.replace(/\n+$/g, "");
  if (chomping === "+") return value.endsWith("\n") || !value ? value : `${value}\n`;
  // Keep the historical PPTD behavior: default block scalars do not add a
  // terminal newline, which makes text edits stable across editor saves.
  return value.replace(/\n+$/g, "");
}

function skipYamlTrivia(lines, cursor) {
  while (cursor.index < lines.length && (!lines[cursor.index].text.trim() || lines[cursor.index].text.trimStart().startsWith("#"))) cursor.index += 1;
}

function nextYamlIndent(lines, cursor) {
  skipYamlTrivia(lines, cursor);
  return lines[cursor.index]?.indent;
}

function parseYamlValue(valueText, lines, cursor, parentIndent, line) {
  const value = stripComment(valueText).trim();
  if (isBlockScalar(value)) return readBlockScalar(lines, cursor, parentIndent, value);
  if (value) return parseScalar(value, line);
  const childIndent = nextYamlIndent(lines, cursor);
  if (childIndent == null || childIndent <= parentIndent) return null;
  return parseYamlBlock(lines, cursor, childIndent);
}

function sequenceMarker(text) {
  return /^-(?:[ \t]|$)/.test(text);
}

function parseYamlMapping(lines, cursor, indent) {
  const result = {};
  while (cursor.index < lines.length) {
    skipYamlTrivia(lines, cursor);
    const item = lines[cursor.index];
    if (!item || item.indent < indent) break;
    if (item.indent > indent || sequenceMarker(item.text)) break;
    const colon = findMappingColon(item.text);
    if (colon === -1) fail(`缺少映射冒号：${item.text}`, item.line);
    const key = yamlKey(item.text.slice(0, colon), item.line);
    cursor.index += 1;
    result[key] = parseYamlValue(item.text.slice(colon + 1), lines, cursor, indent, item.line);
  }
  return result;
}

function parseYamlSequence(lines, cursor, indent) {
  const result = [];
  while (cursor.index < lines.length) {
    skipYamlTrivia(lines, cursor);
    const item = lines[cursor.index];
    if (!item || item.indent < indent || item.indent !== indent || !sequenceMarker(item.text)) break;
    const rest = item.text.replace(/^-\s*/, "");
    cursor.index += 1;
    if (!rest) {
      result.push(parseYamlValue("", lines, cursor, indent, item.line));
      continue;
    }
    if (sequenceMarker(rest)) {
      const nested = [];
      const nestedRest = rest.replace(/^-\s*/, "");
      if (nestedRest) {
        const nestedColon = !nestedRest.startsWith("{") && !nestedRest.startsWith("[") ? findMappingColon(nestedRest) : -1;
        if (nestedColon >= 0) {
          const nestedObject = {};
          const nestedKey = yamlKey(nestedRest.slice(0, nestedColon), item.line);
          nestedObject[nestedKey] = parseYamlValue(nestedRest.slice(nestedColon + 1), lines, cursor, indent + 2, item.line);
          nested.push(nestedObject);
        } else nested.push(parseScalar(nestedRest, item.line));
      }
      const continuationIndent = nextYamlIndent(lines, cursor);
      if (continuationIndent != null && continuationIndent > indent) {
        const more = parseYamlBlock(lines, cursor, continuationIndent);
        if (Array.isArray(more)) nested.push(...more);
        else if (more && typeof more === "object" && !Array.isArray(more) && nested.at(-1) && typeof nested.at(-1) === "object") Object.assign(nested.at(-1), more);
        const nestedSequenceIndent = nextYamlIndent(lines, cursor);
        if (nestedSequenceIndent != null && nestedSequenceIndent > indent && sequenceMarker(lines[cursor.index]?.text ?? "")) {
          const tail = parseYamlBlock(lines, cursor, nestedSequenceIndent);
          if (Array.isArray(tail)) nested.push(...tail);
        }
      }
      result.push(nested);
      continue;
    }
    const colon = !rest.startsWith("{") && !rest.startsWith("[") ? findMappingColon(rest) : -1;
    if (colon === -1) {
      result.push(parseScalar(rest, item.line));
      continue;
    }
    const object = {};
    const key = yamlKey(rest.slice(0, colon), item.line);
    object[key] = parseYamlValue(rest.slice(colon + 1), lines, cursor, indent, item.line);
    const continuationIndent = nextYamlIndent(lines, cursor);
    if (continuationIndent != null && continuationIndent > indent) {
      const more = parseYamlBlock(lines, cursor, continuationIndent);
      if (more && typeof more === "object" && !Array.isArray(more)) Object.assign(object, more);
      else if (more != null) fail("序列映射项的续行必须是映射", item.line);
    }
    result.push(object);
  }
  return result;
}

function parseYamlBlock(lines, cursor, indent = null) {
  skipYamlTrivia(lines, cursor);
  if (cursor.index >= lines.length) return {};
  const first = lines[cursor.index];
  const actualIndent = indent == null || first.indent > indent ? first.indent : indent;
  if (first.indent < actualIndent) return {};
  if (sequenceMarker(first.text)) return parseYamlSequence(lines, cursor, actualIndent);
  if (findMappingColon(first.text) < 0) {
    cursor.index += 1;
    return parseScalar(first.text, first.line);
  }
  return parseYamlMapping(lines, cursor, actualIndent);
}

export function parseYaml(source) {
  if (typeof source !== "string") throw new TypeError("YAML source must be a string");
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* report the more useful YAML parser error below */ }
  }
  const lines = significantLines(source);
  const cursor = { index: 0 };
  const value = parseYamlBlock(lines, cursor);
  skipYamlTrivia(lines, cursor);
  if (cursor.index < lines.length) fail(`无法解析 YAML 行：${lines[cursor.index].text}`, lines[cursor.index].line);
  return value;
}

/*
 * A dependency-free CST facade.  The value parser above is intentionally small,
 * but the editor still needs to keep comments, key order, and untouched source
 * text.  A document therefore carries the original source and a line index;
 * callers can mutate a path and only the affected scalar line is rewritten.
 */
export function parseYamlCst(source) {
  if (typeof source !== "string") throw new TypeError("YAML source must be a string");
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  return { source, value: parseYaml(source), lines, comments: lines.filter((line) => /^\s*#/.test(line)), order: lines.filter((line) => /^\s*[^#\s][^:]*:/.test(line)).map((line) => line.trim().split(/\s*:/, 1)[0]) };
}

function yamlPathSegments(path) {
  if (Array.isArray(path)) return path.map(String);
  return String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
}

function locateYamlPath(sourceLines, segments) {
  const info = sourceLines.map((raw, index) => ({ raw, index, indent: raw.match(/^ */)?.[0].length ?? 0, text: raw.trimStart() }));
  const significant = (start, end) => { const values = []; for (let index = start; index < end; index += 1) if (info[index].text && !info[index].text.startsWith("#")) values.push(info[index]); return values; };
  const childEnd = (line, end) => {
    let index = line.index + 1; let lastChild = index;
    while (index < end) {
      const child = info[index];
      if (!child.text) { index += 1; continue; }
      if (child.indent <= line.indent) break;
      lastChild = index + 1; index += 1;
    }
    return lastChild;
  };
  const find = (start, end, indent, offset) => {
    if (offset >= segments.length) return null;
    const segment = segments[offset]; const numeric = /^\d+$/.test(segment);
    if (numeric) {
      let sequenceIndex = -1;
      for (const line of significant(start, end)) {
        if (line.indent !== indent || !line.text.startsWith("-")) continue;
        sequenceIndex += 1; if (sequenceIndex !== Number(segment)) continue;
        if (offset === segments.length - 1) return { line, colon: -1, end: childEnd(line, end) };
        const rest = line.text.slice(1).trimStart(); const nextKey = segments[offset + 1]; const colon = findMappingColon(`${rest} `);
        if (colon >= 0 && rest.slice(0, colon).trim().replace(/^['"]|['"]$/g, "") === nextKey) {
          if (offset + 1 === segments.length - 1) return { line, colon: line.raw.indexOf(":", line.raw.indexOf("-")), end: childEnd(line, end) };
          const children = significant(line.index + 1, childEnd(line, end)); const childIndent = children[0]?.indent;
          return childIndent == null ? null : find(line.index + 1, childEnd(line, end), childIndent, offset + 2);
        }
        const children = significant(line.index + 1, childEnd(line, end)); const childIndent = children[0]?.indent;
        return childIndent == null ? null : find(line.index + 1, childEnd(line, end), childIndent, offset + 1);
      }
      return null;
    }
    for (const line of significant(start, end)) {
      if (line.indent !== indent || line.text.startsWith("-")) continue;
      const colon = findMappingColon(`${line.text} `); if (colon < 0) continue;
      const key = line.text.slice(0, colon).trim().replace(/^['"]|['"]$/g, ""); if (key !== segment) continue;
      const actualColon = line.raw.indexOf(":", line.indent);
      if (offset === segments.length - 1) return { line, colon: actualColon, end: childEnd(line, end) };
      const children = significant(line.index + 1, childEnd(line, end)); const childIndent = children[0]?.indent;
      return childIndent == null ? null : find(line.index + 1, childEnd(line, end), childIndent, offset + 1);
    }
    return null;
  };
  const root = significant(0, sourceLines.length)[0];
  return root ? find(0, sourceLines.length, root.indent, 0) : null;
}

function inlineComment(value) {
  let quote = null; let depth = 0;
  for (let index = 0; index < value.length; index += 1) { const char = value[index]; if (quote) { if (char === quote && value[index - 1] !== "\\") quote = null; } else if (char === '"' || char === "'") quote = char; else if (char === "[" || char === "{") depth += 1; else if (char === "]" || char === "}") depth -= 1; else if (char === "#" && depth === 0 && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(index); }
  return "";
}

function yamlCstScalar(value) {
  if (Array.isArray(value) && value.every((item) => item == null || typeof item !== "object")) return `[${value.map(yamlScalar).join(", ")}]`;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => item == null || typeof item !== "object")) return `{${Object.entries(value).map(([key, item]) => `${key}: ${yamlScalar(item)}`).join(", ")}}`;
  return yamlScalar(value);
}

export function setYamlCst(document, path, value) {
  if (!document || typeof document.source !== "string") throw new TypeError("无效的 YAML CST 文档");
  const segments = yamlPathSegments(path); const sourceLines = document.source.replaceAll("\r\n", "\n").split("\n"); const located = locateYamlPath(sourceLines, segments);
  let cursor = document.value;
  for (let index = 0; index < segments.length - 1; index += 1) cursor = cursor?.[Array.isArray(cursor) ? Number(segments[index]) : segments[index]];
  const key = segments.at(-1); if (cursor != null && key != null) cursor[Array.isArray(cursor) ? Number(key) : key] = value;
  const inlineObject = Array.isArray(value) ? value.every((item) => item == null || typeof item !== "object") : value && typeof value === "object" ? Object.values(value).every((item) => item == null || typeof item !== "object") : true;
  if (located?.colon < 0 && inlineObject && !(typeof value === "string" && value.includes("\n"))) {
    const line = sourceLines[located.line.index]; const dash = line.indexOf("-", located.line.indent); const oldValue = line.slice(dash + 1); const comment = inlineComment(oldValue);
    sourceLines[located.line.index] = `${line.slice(0, dash + 1)} ${yamlCstScalar(value)}${comment ? ` ${comment}` : ""}`;
    document.source = sourceLines.join("\n"); document.lines = sourceLines; return document;
  }
  if (!located || located.colon < 0) { document.source = stringifyYaml(document.value); document.lines = document.source.split("\n"); return document; }
  const line = sourceLines[located.line.index]; const before = line.slice(0, located.colon + 1); const oldValue = line.slice(located.colon + 1); const comment = inlineComment(oldValue); const block = typeof value === "string" && (value.includes("\n") || /^\s*[|>]/.test(oldValue));
  if (!inlineObject || (located.end > located.line.index + 1 && value && typeof value === "object")) {
    const serialized = stringifyYaml(value, located.line.indent + 2); const body = serialized ? serialized.split("\n") : [];
    const empty = Array.isArray(value) ? " []" : " {}"; const replacement = body.length ? [`${before}${comment ? ` ${comment}` : ""}`, ...body] : [`${before}${empty}${comment ? ` ${comment}` : ""}`];
    sourceLines.splice(located.line.index, Math.max(1, located.end - located.line.index), ...replacement);
  } else if (block) { const indent = " ".repeat(located.line.indent + 2); const replacement = [`${before} |${comment ? ` ${comment}` : ""}`, ...String(value).split("\n").map((item) => `${indent}${item}`)]; let removeEnd = located.line.index + 1; while (removeEnd < sourceLines.length && (!sourceLines[removeEnd].trim() || (sourceLines[removeEnd].match(/^ */)?.[0].length ?? 0) > located.line.indent)) removeEnd += 1; sourceLines.splice(located.line.index, Math.max(1, removeEnd - located.line.index), ...replacement); }
  else sourceLines[located.line.index] = `${before} ${yamlCstScalar(value)}${comment ? ` ${comment}` : ""}`;
  document.source = sourceLines.join("\n"); document.lines = sourceLines; return document;
}

function patchYamlCstSequence(document, path, before, after) {
  const segments = yamlPathSegments(path); const sourceLines = document.source.replaceAll("\r\n", "\n").split("\n"); const parent = locateYamlPath(sourceLines, segments);
  if (!parent || parent.colon < 0 || parent.end <= parent.line.index + 1) return false;
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (before.length === after.length && before.every((item) => item == null || typeof item !== "object") && after.every((item) => item == null || typeof item !== "object")) {
    before.forEach((item, index) => { if (!equal(item, after[index])) setYamlCst(document, [...segments, String(index)], after[index]); });
    return true;
  }
  let start = 0;
  while (start < before.length && start < after.length && equal(before[start], after[start])) start += 1;
  let oldEnd = before.length; let newEnd = after.length;
  while (oldEnd > start && newEnd > start && equal(before[oldEnd - 1], after[newEnd - 1])) { oldEnd -= 1; newEnd -= 1; }
  if (start === oldEnd && start === newEnd) return true;
  const first = start < before.length ? locateYamlPath(sourceLines, [...segments, String(start)]) : null;
  const last = oldEnd > start ? locateYamlPath(sourceLines, [...segments, String(oldEnd - 1)]) : null;
  const insertAt = first?.line.index ?? parent.end;
  const removeEnd = last?.end ?? insertAt;
  const indent = parent.line.indent + 2;
  const replacement = after.slice(start, newEnd).length ? stringifyYaml(after.slice(start, newEnd), indent).split("\n") : [];
  sourceLines.splice(insertAt, Math.max(0, removeEnd - insertAt), ...replacement);
  let cursor = document.value;
  for (let index = 0; index < segments.length - 1; index += 1) cursor = cursor?.[Array.isArray(cursor) ? Number(segments[index]) : segments[index]];
  const key = segments.at(-1); if (cursor != null && key != null) cursor[Array.isArray(cursor) ? Number(key) : key] = after;
  document.source = sourceLines.join("\n"); document.lines = sourceLines; return true;
}

function patchYamlCstMapping(document, path, before, after) {
  const segments = yamlPathSegments(path);
  const removed = Object.keys(before).filter((key) => !(key in after));
  const added = Object.keys(after).filter((key) => !(key in before));
  const sourceLines = document.source.replaceAll("\r\n", "\n").split("\n");
  for (const key of removed) {
    const located = locateYamlPath(sourceLines, [...segments, key]);
    if (!located) return false;
    sourceLines.splice(located.line.index, Math.max(1, located.end - located.line.index));
  }
  if (added.length) {
    const parent = segments.length ? locateYamlPath(sourceLines, segments) : null;
    if (segments.length && !parent) return false;
    const indent = parent ? parent.line.indent + 2 : 0;
    const addition = Object.fromEntries(added.map((key) => [key, after[key]]));
    const serialized = stringifyYaml(addition, indent).split("\n");
    let insertAt = parent ? parent.end : sourceLines.length;
    const lowerBound = parent ? parent.line.index + 1 : 0;
    while (insertAt > lowerBound && (!sourceLines[insertAt - 1].trim() || sourceLines[insertAt - 1].trimStart().startsWith("#"))) insertAt -= 1;
    sourceLines.splice(insertAt, 0, ...serialized);
  }
  document.source = sourceLines.join("\n"); document.lines = sourceLines; return true;
}

export function updateYamlCst(document, nextValue) {
  const changes = []; const structural = [];
  const walk = (before, after, path = []) => {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) { if (before.length !== after.length) { structural.push({ path, before, value: after, sequence: true }); return; } if (before.every((item) => item == null || typeof item !== "object") && after.every((item) => item == null || typeof item !== "object")) { changes.push({ path, before, value: after, sequence: true }); return; } before.forEach((item, index) => walk(item, after[index], [...path, String(index)])); return; }
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) { const keys = new Set([...Object.keys(before), ...Object.keys(after)]); if ([...keys].some((key) => !(key in before) || !(key in after))) structural.push({ path, before, value: after, mapping: true }); for (const key of keys) if (key in before && key in after) walk(before[key], after[key], [...path, key]); return; }
    changes.push({ path, value: after });
  };
  walk(document.value, nextValue);
  for (const change of structural.sort((left, right) => right.path.length - left.path.length)) {
    if (change.mapping && patchYamlCstMapping(document, change.path, change.before, change.value)) continue;
    if (change.sequence && patchYamlCstSequence(document, change.path, change.before, change.value)) continue;
    if (!change.path.length) { document.value = nextValue; document.source = stringifyYaml(nextValue); document.lines = document.source.split("\n"); return document; }
    setYamlCst(document, change.path, change.value);
  }
  for (const change of changes) if (!change.sequence || !patchYamlCstSequence(document, change.path, change.before, change.value)) setYamlCst(document, change.path, change.value);
  document.value = nextValue;
  return document;
}

export function stringifyYamlCst(document) {
  if (document && typeof document.source === "string") return document.source;
  return stringifyYaml(document?.value ?? document);
}

function yamlScalar(value) {
  if (value == null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (/^[A-Za-z0-9_./$-]+$/.test(value) && !["true", "false", "null"].includes(value)) return value;
  return JSON.stringify(value);
}

export function stringifyYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) return value.map((item) => {
    if (item && typeof item === "object") {
      const lines = stringifyYaml(item, indent + 2).split("\n");
      const first = lines.shift().slice(indent + 2);
      return `${pad}- ${first}${lines.length ? `\n${lines.join("\n")}` : ""}`;
    }
    return `${pad}- ${yamlScalar(item)}`;
  }).join("\n");
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => {
    if (item && typeof item === "object") return `${pad}${key}:${item && !Array.isArray(item) && Object.keys(item).length ? `\n${stringifyYaml(item, indent + 2)}` : `\n${stringifyYaml(item, indent + 2)}`}`;
    return `${pad}${key}: ${yamlScalar(item)}`;
  }).join("\n");
  return `${pad}${yamlScalar(value)}`;
}

export function resolveColor(value, theme = {}) {
  const colors = theme?.colors ?? {};
  let result = value;
  const seen = new Set();
  while (typeof result === "string" && result.startsWith("$") && !seen.has(result)) {
    seen.add(result);
    result = colors[result.slice(1)] ?? result;
  }
  if (typeof result !== "string") return "#000000";
  if (/^#[0-9a-f]{8}$/i.test(result)) {
    const alpha = Number.parseInt(result.slice(7), 16) / 255;
    return `rgba(${Number.parseInt(result.slice(1, 3), 16)},${Number.parseInt(result.slice(3, 5), 16)},${Number.parseInt(result.slice(5, 7), 16)},${alpha.toFixed(3)})`;
  }
  return result;
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function decodeEntities(value) {
  return String(value ?? "").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal))).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function stripRichText(value) {
  return decodeEntities(String(value ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}

function formulaTokens(latex, style = {}, theme = {}) {
  const source = String(latex ?? "").trim();
  const mathRun = (text) => `<m:r><a:rPr lang="zh-CN"${style.fontSize == null ? "" : ` sz="${textSize(style.fontSize)}"`}>${style.color ? `<a:solidFill><a:srgbClr val="${colorHex(style.color, theme)}"/></a:solidFill>` : ""}</a:rPr><m:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${escapeXml(text)}</m:t></m:r>`;
  const parseGroup = (value, start) => {
    if (value[start] !== "{") { const command = value.slice(start).match(/^\\[A-Za-z]+/); return command ? { value: command[0], end: start + command[0].length } : { value: value[start] ?? "", end: start + 1 }; }
    let depth = 1; let end = start + 1;
    while (end < value.length && depth) { if (value[end] === "{") depth += 1; else if (value[end] === "}") depth -= 1; end += 1; }
    return { value: value.slice(start + 1, end - 1), end };
  };
  const matrixRows = (value) => {
    const rows = [[]]; let cell = ""; let depth = 0;
    const commitCell = () => { rows.at(-1).push(cell); cell = ""; };
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "{") depth += 1; else if (char === "}") depth = Math.max(0, depth - 1);
      if (depth === 0 && char === "&") { commitCell(); continue; }
      if (depth === 0 && char === "\\" && value[index + 1] === "\\") { commitCell(); rows.push([]); index += 1; continue; }
      cell += char;
    }
    commitCell();
    return rows.filter((row) => row.some((item) => item.trim()));
  };
  const delimiter = (value, start) => {
    let index = start;
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (value[index] !== "\\") return { value: value[index] === "." ? "" : value[index] ?? "", end: index + 1 };
    const named = value.slice(index).match(/^\\([A-Za-z]+)/)?.[1];
    if (named) return { value: ({ langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", vert: "|", Vert: "‖" })[named] ?? named, end: index + named.length + 1 };
    return { value: value[index + 1] === "." ? "" : value[index + 1] ?? "", end: index + 2 };
  };
  const matchingRight = (value, start) => {
    const pattern = /\\(left|right)\b/g; pattern.lastIndex = start; let depth = 0; let match;
    while ((match = pattern.exec(value))) { if (match[1] === "left") depth += 1; else if (depth) depth -= 1; else return match; }
    return null;
  };
  const parse = (value) => {
    const out = []; let i = 0;
    while (i < value.length) {
      let atom = ""; let nary = null;
      if (value[i] === "\\") {
        const command = value.slice(i).match(/^\\([A-Za-z]+)/)?.[1];
        if (command) {
          i += command.length + 1; while (/\s/.test(value[i] ?? "")) i += 1;
          if (command === "frac") { const numerator = parseGroup(value, i); i = numerator.end; while (/\s/.test(value[i] ?? "")) i += 1; const denominator = parseGroup(value, i); i = denominator.end; atom = `<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>${parse(numerator.value)}</m:num><m:den>${parse(denominator.value)}</m:den></m:f>`; }
          else if (command === "binom") { const numerator = parseGroup(value, i); i = numerator.end; while (/\s/.test(value[i] ?? "")) i += 1; const denominator = parseGroup(value, i); i = denominator.end; atom = `<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${parse(numerator.value)}</m:num><m:den>${parse(denominator.value)}</m:den></m:f></m:e></m:d>`; }
          else if (command === "sqrt") { let degree = null; if (value[i] === "[") { const end = value.indexOf("]", i + 1); if (end > i) { degree = value.slice(i + 1, end); i = end + 1; } } const radicand = parseGroup(value, i); i = radicand.end; atom = `<m:rad><m:radPr>${degree == null ? '<m:degHide m:val="1"/>' : ""}</m:radPr><m:deg>${degree == null ? "" : parse(degree)}</m:deg><m:e>${parse(radicand.value)}</m:e></m:rad>`; }
          else if (["overline", "underline"].includes(command)) { const group = parseGroup(value, i); i = group.end; atom = `<m:bar><m:barPr><m:pos m:val="${command === "overline" ? "top" : "bot"}"/></m:barPr><m:e>${parse(group.value)}</m:e></m:bar>`; }
          else if (["hat", "bar", "vec", "tilde", "dot", "ddot"].includes(command)) { const group = parseGroup(value, i); i = group.end; const accent = { hat: "̂", bar: "̅", vec: "⃗", tilde: "̃", dot: "̇", ddot: "̈" }[command]; atom = `<m:acc><m:accPr><m:chr m:val="${accent}"/></m:accPr><m:e>${parse(group.value)}</m:e></m:acc>`; }
          else if (["overset", "underset"].includes(command)) { const limit = parseGroup(value, i); i = limit.end; while (/\s/.test(value[i] ?? "")) i += 1; const base = parseGroup(value, i); i = base.end; const tag = command === "overset" ? "limUpp" : "limLow"; atom = `<m:${tag}><m:e>${parse(base.value)}</m:e><m:lim>${parse(limit.value)}</m:lim></m:${tag}>`; }
          else if (command === "boxed") { const group = parseGroup(value, i); i = group.end; atom = `<m:borderBox><m:borderBoxPr/><m:e>${parse(group.value)}</m:e></m:borderBox>`; }
          else if (command === "begin") { const environment = parseGroup(value, i); i = environment.end; const endMarker = `\\end{${environment.value}}`; const end = value.indexOf(endMarker, i); if (end >= i && ["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases", "aligned"].includes(environment.value)) { const rows = matrixRows(value.slice(i, end)); i = end + endMarker.length; const matrix = `<m:m>${rows.map((row) => `<m:mr>${row.map((cell) => `<m:e>${parse(cell.trim())}</m:e>`).join("")}</m:mr>`).join("")}</m:m>`; const delimiters = { pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""] }[environment.value]; atom = delimiters ? `<m:d><m:dPr><m:begChr m:val="${escapeXml(delimiters[0])}"/><m:endChr m:val="${escapeXml(delimiters[1])}"/></m:dPr><m:e>${matrix}</m:e></m:d>` : matrix; } else atom = mathRun(environment.value); }
          else if (["mathrm", "mathbf", "mathit", "mathbb", "mathcal", "mathsf", "mathtt", "text", "operatorname"].includes(command)) { const group = parseGroup(value, i); i = group.end; atom = parse(group.value); }
          else if (command === "left") { const left = delimiter(value, i); const rightCommand = matchingRight(value, left.end); if (rightCommand) { const right = delimiter(value, rightCommand.index + rightCommand[0].length); atom = `<m:d><m:dPr><m:begChr m:val="${escapeXml(left.value)}"/><m:endChr m:val="${escapeXml(right.value)}"/></m:dPr><m:e>${parse(value.slice(left.end, rightCommand.index))}</m:e></m:d>`; i = right.end; } else { atom = mathRun(left.value); i = left.end; } }
          else if (command === "right") { const right = delimiter(value, i); atom = mathRun(right.value); i = right.end; }
          else { const symbols = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ϵ", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", int: "∫", iint: "∬", iiint: "∭", oint: "∮", sum: "∑", prod: "∏", lim: "lim", sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", exp: "exp", min: "min", max: "max", det: "det", infty: "∞", times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", approx: "≈", equiv: "≡", propto: "∝", in: "∈", notin: "∉", subset: "⊂", supset: "⊃", cup: "∪", cap: "∩", to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", partial: "∂", nabla: "∇" }; if (["int", "iint", "iiint", "oint", "sum", "prod"].includes(command)) nary = symbols[command]; else atom = mathRun(symbols[command] ?? command); }
        } else { atom = mathRun(value[i + 1] ?? ""); i += 2; }
      } else if (value[i] === "{") { const group = parseGroup(value, i); i = group.end; atom = parse(group.value); }
      else { atom = mathRun(value[i]); i += 1; }
      let sub = null; let sup = null;
      while (value[i] === "^" || value[i] === "_") { const operator = value[i]; i += 1; const group = parseGroup(value, i); i = group.end; if (operator === "^") sup = parse(group.value); else sub = parse(group.value); }
      if (nary) atom = `<m:nary><m:naryPr><m:chr m:val="${escapeXml(nary)}"/><m:limLoc m:val="subSup"/></m:naryPr><m:sub>${sub ?? ""}</m:sub><m:sup>${sup ?? ""}</m:sup><m:e/></m:nary>`;
      else if (sub && sup) atom = `<m:sSubSup><m:e>${atom}</m:e><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup></m:sSubSup>`;
      else if (sup) atom = `<m:sSup><m:e>${atom}</m:e><m:sup>${sup}</m:sup></m:sSup>`;
      else if (sub) atom = `<m:sSub><m:e>${atom}</m:e><m:sub>${sub}</m:sub></m:sSub>`;
      if (atom) out.push(atom);
    }
    return out.join("");
  };
  return parse(source);
}

export function latexToOmml(latex) {
  return `<m:oMath>${formulaTokens(latex)}</m:oMath>`;
}

function parseRichText(value, inherited = {}) {
  const source = String(value ?? ""); const paragraphs = []; const stack = [{ tag: "root", style: { ...inherited } }]; const lists = []; let paragraph = null;
  const begin = (style = stack.at(-1).style, bullet = null) => { if (paragraph && !paragraph.length && !paragraph.explicit) { paragraph.style = { ...style }; paragraph.bullet = bullet; paragraph.explicit = true; return paragraph; } paragraph = []; paragraph.style = { ...style }; paragraph.bullet = bullet; paragraph.explicit = true; paragraphs.push(paragraph); return paragraph; };
  const current = () => paragraph ?? begin(stack.at(-1).style);
  const pushText = (text) => { const parts = decodeEntities(text).split(/\r?\n/); parts.forEach((part, index) => { if (index) paragraph = null; if (part) current().push({ text: part, style: { ...stack.at(-1).style } }); }); };
  const styled = (tag, attrs) => {
    const next = { ...stack.at(-1).style };
    if (tag === "strong" || tag === "b") next.bold = true; if (tag === "em" || tag === "i") next.italic = true; if (tag === "u") next.underline = true; if (tag === "s") next.strike = true; if (tag === "sup") next.baseline = 30000; if (tag === "sub") next.baseline = -25000;
    if (tag === "a") { const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]; if (href && /^(?:https?:\/\/|mailto:)/i.test(href)) { next.href = decodeEntities(href); next.color = "#0563C1"; next.underline = true; } }
    const css = attrs.match(/style\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    for (const part of css.split(";")) { const colon = part.indexOf(":"); if (colon < 0) continue; const key = part.slice(0, colon).trim().toLowerCase(); const raw = part.slice(colon + 1).trim(); if (!key || !raw) continue; if (key === "color") next.color = raw; else if (key === "font-size") next.fontSize = Number.parseFloat(raw); else if (key === "font-family") next.fontFamily = raw.replace(/^['"]|['"]$/g, ""); else if (key === "background-color") next.backgroundColor = raw; else if (key === "text-align") next.textAlign = raw; else if (key === "line-height") raw.endsWith("px") ? next.lineHeightPx = Number.parseFloat(raw) : next.lineHeight = Number(raw); else if (key === "margin-top") next.marginTop = Number.parseFloat(raw); else if (key === "margin-left") next.marginLeft = Number.parseFloat(raw); else if (key === "margin-right") next.marginRight = Number.parseFloat(raw); else if (key === "letter-spacing") next.letterSpacing = Number.parseFloat(raw); else if (key === "list-style-type") next.listStyleType = raw; else if (key === "list-style") next.listStyleType = raw.split(/\s+/)[0]; else if (key === "list-style-position") next.listStylePosition = raw; else if (key === "list-style-image") next.listStyleImage = raw; }
    return next;
  };
  let cursor = 0; const token = /<[^>]+>|\\\([^]*?\\\)/g;
  for (const match of source.matchAll(token)) {
    pushText(source.slice(cursor, match.index)); const raw = match[0]; cursor = match.index + raw.length;
    if (raw.startsWith("\\(")) current().push({ formula: raw.slice(2, -2), style: { ...stack.at(-1).style } });
    else if (/^<br\b/i.test(raw)) current().push({ break: true, style: { ...stack.at(-1).style } });
    else if (/^<\/(?:ul|ol)/i.test(raw)) lists.pop();
    else if (/^<(?:ul|ol)\b/i.test(raw)) lists.push({ type: /^<ol/i.test(raw) ? "ordered" : "unordered", index: 0 });
    else if (/^<\/(?:p|li)/i.test(raw)) { if (stack.length > 1) stack.pop(); paragraph = null; }
    else if (/^<(?:p|li)\b/i.test(raw)) { const tag = raw.match(/^<\s*([A-Za-z0-9]+)/)[1].toLowerCase(); const style = styled(tag, raw); const list = tag === "li" ? lists.at(-1) : null; if (list) list.index += 1; begin(style, list ? { type: list.type, startAt: list.index, style: style.listStyleType, position: style.listStylePosition, image: style.listStyleImage } : null); stack.push({ tag, style }); }
    else if (/^<\//.test(raw)) { if (stack.length > 1) stack.pop(); }
    else { const tag = raw.match(/^<\s*([A-Za-z0-9]+)/)?.[1]?.toLowerCase() ?? "span"; const style = styled(tag, raw); stack.push({ tag, style }); }
  }
  pushText(source.slice(cursor));
  return paragraphs.length ? paragraphs.filter((item, index) => item.length || index === 0) : [Object.assign([], { style: { ...inherited } })];
}

function themeStyle(page, content, theme) {
  const styleName = content?.style;
  const inherited = styleName && typeof styleName === "string" && styleName.startsWith("$") ? theme?.textStyles?.[styleName.slice(1)] ?? {} : {};
  return { ...inherited, ...(content ?? {}) };
}

function svgId(value) {
  return String(value ?? "fill").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function imagePreserveAspectRatio(mode) {
  return mode === "contain" ? "xMidYMid meet" : mode === "fill" ? "none" : "xMidYMid slice";
}

function normalizedImageCrop(crop = {}) {
  const value = (key) => Number.isFinite(Number(crop?.[key])) ? Number(crop[key]) : 0;
  let left = value("left"); let top = value("top"); let right = value("right"); let bottom = value("bottom");
  // Keep the source rectangle non-degenerate while retaining negative outsets.
  if (left + right >= 1) right = 1 - left - 1e-6;
  if (top + bottom >= 1) bottom = 1 - top - 1e-6;
  return { left, top, right, bottom, width: Math.max(1e-6, 1 - left - right), height: Math.max(1e-6, 1 - top - bottom) };
}

function imageHref(src, resourceResolver) {
  if (!src) return "";
  if (resourceResolver) return resourceResolver(src) || "";
  return String(src);
}

function addImageFillPattern(fill, theme, id, resourceResolver, defs) {
  const href = imageHref(fill?.src, resourceResolver);
  if (!href || !defs) return "none";
  const crop = normalizedImageCrop(fill.crop);
  const viewBox = `${crop.left * 100} ${crop.top * 100} ${crop.width * 100} ${crop.height * 100}`;
  const patternId = `${svgId(id)}-image-fill`;
  const opacity = Math.max(0, Math.min(1, Number(fill.opacity ?? 1)));
  defs.push(`<pattern id="${patternId}" patternUnits="objectBoundingBox" x="0" y="0" width="1" height="1"><svg x="0" y="0" width="1" height="1" viewBox="${viewBox}" preserveAspectRatio="${imagePreserveAspectRatio(fill.fit?.mode)}"><image href="${escapeXml(href)}" x="0" y="0" width="100" height="100" preserveAspectRatio="none" opacity="${opacity}"/></svg></pattern>`);
  return `url(#${patternId})`;
}

function fillSvg(fill, theme, id, resourceResolver, defs) {
  if (!fill) return "none";
  if (typeof fill === "string") return resolveColor(fill, theme);
  if (fill.type === "image") return addImageFillPattern(fill, theme, id, resourceResolver, defs);
  if (fill.type === "solid" || fill.color) return resolveColor(fill.color ?? "#00000000", theme);
  if (fill.type === "gradient" && Array.isArray(fill.stops)) {
    const stops = fill.stops.map((stop) => `<stop offset="${Math.max(0, Math.min(1, Number(stop.position) || 0)) * 100}%" stop-color="${escapeXml(resolveColor(stop.color, theme))}"/>`).join("");
    const angle = Number(fill.angle) || 0;
    const radians = angle * Math.PI / 180;
    const gradientType = fill.gradientType === "radial" ? "radial" : "linear";
    return `url(#${id}-gradient-${Math.round(angle)})|${stops}|${Math.cos(radians) * 50 + 50}|${Math.sin(radians) * 50 + 50}|${gradientType}`;
  }
  return "none";
}

// Keep previews, validation, and OOXML adjustment guides on the same ECMA-376
// source of truth. Generated geometry data intentionally owns all 177 names.
const PRESET_SHAPE_NAMES = Object.keys(ECMA_PRESET_GEOMETRIES);
const SHAPE_ADJUSTMENTS = Object.fromEntries(Object.entries(ECMA_PRESET_GEOMETRIES).map(([name, definition]) => [name, (definition.a ?? []).map(([, value]) => Number(value))]));
const SHAPE_ADJUSTMENT_NAMES = Object.fromEntries(Object.entries(ECMA_PRESET_GEOMETRIES).map(([name, definition]) => [name, (definition.a ?? []).map(([guideName]) => guideName)]));

export { ECMA_PRESET_GEOMETRIES, PRESET_SHAPE_NAMES, SHAPE_ADJUSTMENTS, SHAPE_ADJUSTMENT_NAMES };

function adjustmentGuidesXml(shapeName, values) {
  const names = SHAPE_ADJUSTMENT_NAMES[shapeName] ?? values.map((_, index) => values.length === 1 ? "adj" : `adj${index + 1}`);
  return values.map((value, index) => `<a:gd name="${names[index]}" fmla="val ${Math.round(Number(value) || 0)}"/>`).join("");
}

const shapeMap = Object.fromEntries(PRESET_SHAPE_NAMES.map((name) => [name, name]));
shapeMap.circle = "ellipse";

function polygonPoints(kind, x, y, w, h) {
  if (kind === "triangle") return `${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`;
  if (kind === "diamond") return `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
  if (kind === "hexagon") return `${x + w * .25},${y} ${x + w * .75},${y} ${x + w},${y + h / 2} ${x + w * .75},${y + h} ${x + w * .25},${y + h} ${x},${y + h / 2}`;
  if (kind === "pentagon") return `${x + w / 2},${y} ${x + w},${y + h * .38} ${x + w * .8},${y + h} ${x + w * .2},${y + h} ${x},${y + h * .38}`;
  if (kind === "rightArrow") return `${x},${y + h * .25} ${x + w * .62},${y + h * .25} ${x + w * .62},${y} ${x + w},${y + h / 2} ${x + w * .62},${y + h} ${x + w * .62},${y + h * .75} ${x},${y + h * .75}`;
  if (kind === "leftArrow") return `${x + w},${y + h * .25} ${x + w * .38},${y + h * .25} ${x + w * .38},${y} ${x},${y + h / 2} ${x + w * .38},${y + h} ${x + w * .38},${y + h * .75} ${x + w},${y + h * .75}`;
  if (kind === "upArrow") return `${x + w * .25},${y + h} ${x + w * .25},${y + h * .38} ${x},${y + h * .38} ${x + w / 2},${y} ${x + w},${y + h * .38} ${x + w * .75},${y + h * .38} ${x + w * .75},${y + h}`;
  if (kind === "downArrow") return `${x + w * .25},${y} ${x + w * .25},${y + h * .62} ${x},${y + h * .62} ${x + w / 2},${y + h} ${x + w},${y + h * .62} ${x + w * .75},${y + h * .62} ${x + w * .75},${y}`;
  if (kind === "chevron") return `${x},${y} ${x + w * .55},${y} ${x + w},${y + h / 2} ${x + w * .55},${y + h} ${x},${y + h} ${x + w * .45},${y + h / 2}`;
  if (kind === "plus") return `${x + w * .35},${y} ${x + w * .65},${y} ${x + w * .65},${y + h * .35} ${x + w},${y + h * .35} ${x + w},${y + h * .65} ${x + w * .65},${y + h * .65} ${x + w * .65},${y + h} ${x + w * .35},${y + h} ${x + w * .35},${y + h * .65} ${x},${y + h * .65} ${x},${y + h * .35} ${x + w * .35},${y + h * .35}`;
  const sides = { pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8, decagon: 10, dodecagon: 12 }[kind];
  if (sides) return Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / sides;
    return `${x + w / 2 + Math.cos(angle) * w / 2},${y + h / 2 + Math.sin(angle) * h / 2}`;
  }).join(" ");
  const starMatch = kind.match(/^star(4|5|6|7|8|10|12|16|24|32)$/);
  if (starMatch) {
    const points = Number(starMatch[1]);
    return Array.from({ length: points * 2 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / points;
      const radius = index % 2 ? .42 : .5;
      return `${x + w / 2 + Math.cos(angle) * w * radius},${y + h / 2 + Math.sin(angle) * h * radius}`;
    }).join(" ");
  }
  return null;
}

function svgTransformForElement(element) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const cx = x + w / 2; const cy = y + h / 2;
  const rotate = Number(element.rotation ?? element.rotate ?? 0);
  const sx = element.flip?.[0] || element.flipH ? -1 : 1; const sy = element.flip?.[1] || element.flipV ? -1 : 1;
  return rotate || sx < 0 || sy < 0 ? `translate(${cx} ${cy}) rotate(${rotate}) scale(${sx} ${sy}) translate(${-cx} ${-cy})` : "";
}

function wrapSvgTransform(element, markup) {
  const transform = svgTransformForElement(element);
  return transform ? `<g transform="${transform}">${markup}</g>` : markup;
}

const ECMA_C_TO_RAD = Math.PI / (60000 * 180);
const ECMA_BASE_GUIDES = {
  // The ECMA names begin with a digit (3cd4, 3cd8, ...).  Keep the
  // underscore aliases accepted by older generated tables as well.
  "3cd4": 16200000, "3cd8": 8100000, "5cd8": 13500000, "7cd8": 18900000,
  _3cd4: 16200000, _3cd8: 8100000, _5cd8: 13500000, _7cd8: 18900000,
  cd2: 10800000, cd4: 5400000, cd8: 2700000, l: 0, t: 0,
};

function ecmaToken(value, guides) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (Object.prototype.hasOwnProperty.call(guides, value)) return guides[value];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function ecmaGuides(shapeName, width, height, adjustments = []) {
  const definition = ECMA_PRESET_GEOMETRIES[shapeName];
  if (!definition) return null;
  const guides = {
    ...ECMA_BASE_GUIDES, h: height, b: height, hd2: height / 2, hd3: height / 3,
    hd4: height / 4, hd5: height / 5, hd6: height / 6, hd8: height / 8,
    hd10: height / 10, hd12: height / 12, hd32: height / 32, vc: height / 2,
    w: width, r: width, wd2: width / 2, wd3: width / 3, wd4: width / 4,
    wd5: width / 5, wd6: width / 6, wd8: width / 8, wd10: width / 10,
    wd12: width / 12, wd32: width / 32, hc: width / 2,
    ls: Math.max(width, height), ss: Math.min(width, height),
  };
  guides.ssd2 = guides.ss / 2; guides.ssd4 = guides.ss / 4; guides.ssd6 = guides.ss / 6;
  guides.ssd8 = guides.ss / 8; guides.ssd16 = guides.ss / 16; guides.ssd32 = guides.ss / 32;
  for (let index = 0; index < (definition.a ?? []).length; index += 1) {
    const [name, fallback] = definition.a[index];
    guides[name] = Number(adjustments[index] == null ? fallback : adjustments[index]);
  }
  for (const [name, formula, x, y, z] of definition.g ?? []) {
    const a = ecmaToken(x, guides); const b = ecmaToken(y, guides); const c = ecmaToken(z, guides);
    let value;
    switch (Number(formula)) {
      case 0: value = c === 0 ? 0 : a * b / c; break; // */
      case 1: value = a + b - c; break; // +-
      case 2: value = c === 0 ? 0 : (a + b) / c; break; // +/
      case 3: value = a > 0 ? b : c; break; // ?:
      case 4: value = Math.abs(a); break;
      case 5: value = Math.atan2(b, a) / ECMA_C_TO_RAD; break; // at2
      case 6: value = a * Math.cos(Math.atan2(c, b)); break; // cat2
      case 7: value = a * Math.cos(b * ECMA_C_TO_RAD); break;
      case 8: value = Math.max(a, b); break;
      case 9: value = Math.hypot(a, b, c); break;
      case 10: value = Math.max(a, Math.min(b, c)); break;
      case 11: value = a * Math.sin(Math.atan2(c, b)); break; // sat2
      case 12: value = a * Math.sin(b * ECMA_C_TO_RAD); break;
      case 13: value = Math.sqrt(Math.max(0, a)); break;
      case 14: value = a * Math.tan(b * ECMA_C_TO_RAD); break;
      case 15: value = a; break;
      case 16: value = Math.min(a, b); break;
      default: value = 0;
    }
    guides[name] = Number.isFinite(value) ? value : 0;
  }
  return guides;
}

function ecmaPathValue(value, guides, axisSize, pathSize) {
  const hasPathSize = pathSize != null;
  const scale = !hasPathSize ? 1 : Number(pathSize) > 0 ? axisSize / Number(pathSize) : 0;
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(guides, value)) return guides[value] * scale;
  const numeric = Number(value);
  const numericScale = hasPathSize ? scale : axisSize / 36000;
  return (Number.isFinite(numeric) ? numeric : 0) * numericScale;
}

function ecmaArcGeometry(startX, startY, rx, ry, startAngle) {
  // ECMA arc angles are measured on the ellipse before the path is emitted.
  // Once the current point and the start angle are known, the center is
  // fixed for every segment of the same arc.  Recomputing the center from the
  // original point for each segment makes a full circle drift outside its
  // bounds (most visibly on smileyFace, ellipse and donut).
  const offset = (angleValue) => {
    const angle = angleValue * ECMA_C_TO_RAD; const cos = Math.cos(angle); const sin = Math.sin(angle);
    const scale = 1 / Math.sqrt((cos / Math.max(1e-9, rx)) ** 2 + (sin / Math.max(1e-9, ry)) ** 2);
    return [scale * cos, scale * sin];
  };
  const start = offset(startAngle);
  return {
    cx: startX - start[0],
    cy: startY - start[1],
    point(endAngle) {
      const end = offset(endAngle);
      return { x: this.cx + end[0], y: this.cy + end[1] };
    },
  };
}

function ecmaArcCommands(startX, startY, rx, ry, startAngle, sweepAngle) {
  if (!(rx > 0) || !(ry > 0) || !Number.isFinite(sweepAngle) || Math.abs(sweepAngle) < 1e-7) return [];
  const pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / 10800000));
  const step = sweepAngle / pieces; const commands = []; const geometry = ecmaArcGeometry(startX, startY, rx, ry, startAngle);
  for (let index = 0; index < pieces; index += 1) {
    const a0 = startAngle + step * index; const a1 = a0 + step; const endpoint = geometry.point(a1);
    commands.push(`A ${rx} ${ry} 0 ${Math.abs(step) > 10800000 ? 1 : 0} ${step >= 0 ? 1 : 0} ${endpoint.x} ${endpoint.y}`);
  }
  return commands;
}

function ecmaPresetPaths(shapeName, width, height, adjustments = []) {
  const definition = ECMA_PRESET_GEOMETRIES[shapeName];
  if (!definition) return null;
  const guides = ecmaGuides(shapeName, width, height, adjustments); const paths = []; let current = null; let currentPoint = [0, 0]; let subpathStart = [0, 0];
  for (const command of definition.p ?? []) {
    const kind = Number(command[0]);
    if (kind === 0) {
      current = { fill: command[2], stroke: command[3], d: [], pathWidth: command[4] == null ? null : ecmaToken(command[4], guides), pathHeight: command[5] == null ? null : ecmaToken(command[5], guides) };
      paths.push(current); currentPoint = [0, 0]; continue;
    }
    if (!current) continue;
    const pathWidth = current.pathWidth; const pathHeight = current.pathHeight;
    if (kind === 1 || kind === 2) {
      const point = [ecmaPathValue(command[1], guides, width, pathWidth), ecmaPathValue(command[2], guides, height, pathHeight)];
      current.d.push(`${kind === 1 ? "M" : "L"} ${point[0]} ${point[1]}`); currentPoint = point; if (kind === 1) subpathStart = point;
    } else if (kind === 3) {
      const rx = ecmaPathValue(command[1], guides, width, pathWidth); const ry = ecmaPathValue(command[2], guides, height, pathHeight);
      const startAngle = ecmaToken(command[3], guides); const rawSweep = ecmaToken(command[4], guides);
      const sx = pathWidth != null && Number(pathWidth) > 0 ? width / Number(pathWidth) : pathWidth != null ? 0 : 1;
      const sy = pathHeight != null && Number(pathHeight) > 0 ? height / Number(pathHeight) : pathHeight != null ? 0 : 1;
      const adjustedStart = Math.atan2(sy * Math.sin(startAngle * ECMA_C_TO_RAD), sx * Math.cos(startAngle * ECMA_C_TO_RAD)) / ECMA_C_TO_RAD;
      const adjustedEnd = Math.atan2(sy * Math.sin((startAngle + rawSweep) * ECMA_C_TO_RAD), sx * Math.cos((startAngle + rawSweep) * ECMA_C_TO_RAD)) / ECMA_C_TO_RAD;
      let sweep = adjustedEnd - adjustedStart;
      if (sweep > 0 && rawSweep < 0) sweep -= 21600000;
      if (sweep < 0 && rawSweep > 0) sweep += 21600000;
      if (sweep === 0 && rawSweep !== 0) sweep = rawSweep > 0 ? 21600000 : -21600000;
      current.d.push(...ecmaArcCommands(currentPoint[0], currentPoint[1], rx, ry, adjustedStart, sweep));
      const endpoint = ecmaArcGeometry(currentPoint[0], currentPoint[1], rx, ry, adjustedStart).point(adjustedStart + sweep); currentPoint = [endpoint.x, endpoint.y];
    } else if (kind === 4) {
      const c1 = [ecmaPathValue(command[1], guides, width, pathWidth), ecmaPathValue(command[2], guides, height, pathHeight)]; const end = [ecmaPathValue(command[3], guides, width, pathWidth), ecmaPathValue(command[4], guides, height, pathHeight)];
      current.d.push(`Q ${c1[0]} ${c1[1]} ${end[0]} ${end[1]}`); currentPoint = end;
    } else if (kind === 5) {
      const c1 = [ecmaPathValue(command[1], guides, width, pathWidth), ecmaPathValue(command[2], guides, height, pathHeight)]; const c2 = [ecmaPathValue(command[3], guides, width, pathWidth), ecmaPathValue(command[4], guides, height, pathHeight)]; const end = [ecmaPathValue(command[5], guides, width, pathWidth), ecmaPathValue(command[6], guides, height, pathHeight)];
      current.d.push(`C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${end[0]} ${end[1]}`); currentPoint = end;
    } else if (kind === 6) { current.d.push("Z"); currentPoint = subpathStart; }
  }
  return paths;
}

function renderEcmaPresetShape(element, theme, defs, index, kind, resourceResolver) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const stroke = element.line?.color ? resolveColor(element.line.color, theme) : (element.border?.color ? resolveColor(element.border.color, theme) : "none"); const strokeWidth = Number(element.line?.width ?? element.border?.width ?? 0); const opacity = Number(element.opacity ?? 1);
  const paths = ecmaPresetPaths(kind, w, h, Array.isArray(element.adjustments) ? element.adjustments : SHAPE_ADJUSTMENTS[kind]);
  if (!paths) return null;
  const sourceFill = element.fill ?? element.background;
  const adjustColor = (value, amount) => {
    const resolved = resolveColor(value, theme);
    if (!/^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|rgba?\()/i.test(resolved)) return value;
    const parts = colorParts(resolved, theme);
    const rgb = [0, 2, 4].map((offset) => Number.parseInt(parts.hex.slice(offset, offset + 2), 16));
    const adjust = (channel) => amount >= 0 ? channel * (1 - amount) + amount * 255 : channel * (1 + amount);
    const adjusted = rgb.map((channel) => Math.floor(Math.max(0, Math.min(255, adjust(channel))) + .5));
    const hex = adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("");
    return parts.alpha == null ? `#${hex}` : `rgba(${adjusted.join(",")},${(parts.alpha / 255).toFixed(3)})`;
  };
  const adjustedFillValue = (mode) => {
    if (!mode || mode === "norm" || mode === true || mode === false) return sourceFill;
    // ECMA path fill modes match the DrawingML/ONLYOFFICE brightness steps:
    // darken/lighten use 40%, while the Less variants use 20%.
    const amount = { darken: -.4, darkenLess: -.2, lighten: .4, lightenLess: .2 }[mode];
    if (amount == null || sourceFill == null) return sourceFill;
    if (sourceFill && typeof sourceFill === "object" && sourceFill.type === "gradient" && Array.isArray(sourceFill.stops)) {
      return { ...sourceFill, stops: sourceFill.stops.map((stop) => ({ ...stop, color: adjustColor(stop.color ?? "#000000", amount) })) };
    }
    if (sourceFill && typeof sourceFill === "object" && (sourceFill.type === "solid" || sourceFill.color != null)) return { ...sourceFill, color: adjustColor(sourceFill.color ?? "#000000", amount) };
    return typeof sourceFill === "string" ? adjustColor(sourceFill, amount) : sourceFill;
  };
  const renderFill = (value, pathIndex) => {
    const rendered = fillSvg(value, theme, `s${index}-p${pathIndex}`, resourceResolver, defs);
    if (!rendered.includes("|")) return rendered;
    const [url, stops, x2, y2, gradientType] = rendered.split("|");
    const angle = Math.round(Number(value?.angle) || 0);
    const gradientId = `s${index}-p${pathIndex}-gradient-${angle}`;
    defs.push(gradientType === "radial" ? `<radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>` : `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`);
    return url;
  };
  return wrapSvgTransform(element, paths.filter((path) => path.d.length).map((path, pathIndex) => { const pathFill = path.fill === "none" ? "none" : renderFill(adjustedFillValue(path.fill), pathIndex); const pathStroke = path.stroke === false || path.stroke === "none" ? "none" : stroke; return `<path d="${escapeXml(path.d.join(" "))}" transform="translate(${x} ${y})" fill="${escapeXml(pathFill)}"${pathStroke !== "none" ? ` stroke="${escapeXml(pathStroke)}" stroke-width="${strokeWidth || 1}"` : ""} opacity="${opacity}"/>`; }).join(""));
}

function renderShape(element, theme, defs, index, resourceResolver) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const kind = shapeMap[element.shapeName] ?? "rect";
  if (kind !== "custom" && ECMA_PRESET_GEOMETRIES[kind]) return renderEcmaPresetShape(element, theme, defs, index, kind, resourceResolver);
  const fillValue = fillSvg(element.fill ?? element.background, theme, `s${index}`, resourceResolver, defs);
  let fill = fillValue;
  if (fillValue.includes("|")) {
    const [url, stops, x2, y2, gradientType] = fillValue.split("|");
    const gradientId = `s${index}-gradient-${Math.round(Number(element.fill?.angle) || 0)}`;
    defs.push(gradientType === "radial" ? `<radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>` : `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`);
    fill = url;
  }
  const stroke = element.line?.color ? resolveColor(element.line.color, theme) : (element.border?.color ? resolveColor(element.border.color, theme) : "none");
  const strokeWidth = Number(element.line?.width ?? element.border?.width ?? 0);
  const common = `fill="${escapeXml(fill)}"${stroke !== "none" ? ` stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}"` : ""} opacity="${Number(element.opacity ?? 1)}"`;
  if (kind === "ellipse") return wrapSvgTransform(element, `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${common}/>`);
  if (kind === "roundRect") return wrapSvgTransform(element, `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) * .12}" ${common}/>`);
  const points = polygonPoints(kind, x, y, w, h);
  if (points) return wrapSvgTransform(element, `<polygon points="${points}" ${common}/>`);
  if (kind === "line") return wrapSvgTransform(element, `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" ${common.replace("fill=\"none\"", "fill=\"none\" stroke=\"currentColor\"")}/>`);
  if (element.path) {
    const viewBox = element.viewBox ?? [100, 100];
    return wrapSvgTransform(element, `<path d="${escapeXml(element.path)}" transform="translate(${x} ${y}) scale(${w / Number(viewBox[0] || 100)} ${h / Number(viewBox[1] || 100)})" ${common}/>`);
  }
  return wrapSvgTransform(element, `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${common}/>`);
}

function renderLine(element, theme) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0]; const viewBox = element.viewBox ?? [1, 1];
  const points = String(element.points ?? "0,0 1,1").trim().split(/\s+/).map((item) => item.split(",").map(Number)).filter((item) => item.length === 2 && item.every(Number.isFinite));
  const transform = ([pxValue, pyValue]) => [x + pxValue / Number(viewBox[0] || 1) * w, y + pyValue / Number(viewBox[1] || 1) * h]; const scaled = points.map(transform);
  let d = scaled.length ? `M${scaled[0][0]},${scaled[0][1]}` : `M${x},${y}`;
  if (scaled.length === 3) d += ` Q${scaled[1][0]},${scaled[1][1]} ${scaled[2][0]},${scaled[2][1]}`;
  else if (scaled.length >= 4) d += ` C${scaled[1][0]},${scaled[1][1]} ${scaled[2][0]},${scaled[2][1]} ${scaled[3][0]},${scaled[3][1]}${scaled.slice(4).map((pointValue) => ` L${pointValue[0]},${pointValue[1]}`).join("")}`;
  else for (const pointValue of scaled.slice(1)) d += ` L${pointValue[0]},${pointValue[1]}`;
  const border = element.border ?? {}; const dash = border.style === "dash" ? ' stroke-dasharray="8 5"' : border.style === "dot" ? ' stroke-dasharray="2 4"' : "";
  return `<path d="${d}" fill="none" stroke="${escapeXml(resolveColor(border.color ?? "#000000", theme))}" stroke-width="${Number(border.width ?? 1)}"${dash}/>`;
}

function approximateTextWidth(value, style, fallbackSize = 16) {
  const size = Number(style?.fontSize ?? fallbackSize);
  const spacing = Number(style?.letterSpacing ?? 0);
  return [...String(value ?? "")].reduce((sum, char) => {
    if (/\s/.test(char)) return sum + size * .28 + spacing;
    if (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(char)) return sum + size + spacing;
    if (/[.,;:!?、。，；：！？]/u.test(char)) return sum + size * .45 + spacing;
    return sum + size * .56 + spacing;
  }, 0);
}

function appendWrappedRun(lines, run, style, maxWidth, wrap, fallbackSize) {
  if (run.break) { lines.push([]); return; }
  const value = String(run.formula ?? run.text ?? "");
  if (!value) return;
  const sourceStyle = { ...style, ...(run.style ?? {}) };
  const add = (text) => {
    if (!text) return;
    const current = lines.at(-1);
    const previous = current.at(-1);
    if (previous && JSON.stringify(previous.style) === JSON.stringify(sourceStyle)) previous.text += text;
    else current.push({ text, style: sourceStyle });
  };
  for (const char of [...value]) {
    if (char === "\n") { lines.push([]); continue; }
    const current = lines.at(-1);
    const currentText = current.map((item) => item.text).join("");
    const width = approximateTextWidth(currentText, sourceStyle, fallbackSize);
    const charWidth = approximateTextWidth(char, sourceStyle, fallbackSize);
    if (wrap && currentText && width + charWidth > maxWidth) {
      // Do not leave whitespace stranded at the beginning of a wrapped line.
      if (/\s/.test(char)) continue;
      while (lines.at(-1).at(-1)?.text && /\s$/.test(lines.at(-1).at(-1).text)) lines.at(-1).at(-1).text = lines.at(-1).at(-1).text.replace(/\s+$/g, "");
      lines.push([]);
    }
    add(char);
  }
}

function renderText(element, theme) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const content = themeStyle(null, element.content ?? {}, theme);
  const paragraphs = parseRichText(content.text ?? element.text ?? "", content);
  const baseSize = Number(content.fontSize ?? 16);
  const baseFamily = typeof content.fontFamily === "object" ? content.fontFamily.latin ?? content.fontFamily.eastAsia : content.fontFamily ?? theme?.fontFamily ?? "Arial";
  const padding = Array.isArray(content.padding) ? content.padding.length === 2 ? [content.padding[1], content.padding[0], content.padding[1], content.padding[0]] : [content.padding[3] ?? 0, content.padding[0] ?? 0, content.padding[1] ?? 0, content.padding[2] ?? 0] : [0, 0, 0, 0];
  const availableWidth = Math.max(1, w - padding[0] - padding[2]);
  const layouts = paragraphs.map((paragraph) => {
    const style = { ...content, ...(paragraph.style ?? {}) };
    const bullet = paragraph.bullet ? paragraph.bullet.type === "ordered" ? `${paragraph.bullet.startAt}. ` : paragraph.bullet.style === "none" ? "" : `${{ circle: "○", square: "■" }[paragraph.bullet.style] ?? "•"} ` : "";
    const lines = [[]];
    if (bullet) appendWrappedRun(lines, { text: bullet }, style, availableWidth, content.wrap !== false, baseSize);
    for (const run of paragraph) appendWrappedRun(lines, run, style, availableWidth, content.wrap !== false, baseSize);
    while (lines.length > 1 && !lines.at(-1).length) lines.pop();
    const lineLayouts = lines.map((line) => {
      const maxSize = Math.max(baseSize, ...line.map((run) => Number(run.style?.fontSize ?? baseSize)));
      const lineHeight = Number(style.lineHeightPx ?? maxSize * Number(style.lineHeight ?? 1.2));
      return { runs: line, maxSize, lineHeight };
    });
    return { style, lines: lineLayouts, height: lineLayouts.reduce((sum, line) => sum + line.lineHeight, 0) + Number(style.marginTop ?? 0) };
  });
  const totalHeight = layouts.reduce((sum, layout) => sum + layout.height, 0);
  const vertical = content.align?.[1] ?? "top";
  let cursorY = vertical === "middle" ? y + Math.max(0, (h - totalHeight) / 2) : vertical === "bottom" ? y + Math.max(0, h - totalHeight) : y;
  const texts = layouts.map(({ style, lines }) => {
    cursorY += Number(style.marginTop ?? 0);
    const align = style.textAlign ?? style.align?.[0] ?? content.align?.[0] ?? "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const left = x + padding[0] + Number(style.marginLeft ?? 0);
    const right = x + w - padding[2] - Number(style.marginRight ?? 0);
    const tx = align === "center" ? (left + right) / 2 : align === "right" ? right : left;
    const lineBits = lines.map(({ runs, maxSize, lineHeight }) => {
      let first = true;
      const runXml = runs.map((run) => {
        const runStyle = { ...style, ...(run.style ?? {}) };
        const family = typeof runStyle.fontFamily === "object" ? runStyle.fontFamily.latin ?? runStyle.fontFamily.eastAsia : runStyle.fontFamily ?? baseFamily;
        const position = first ? ` x="${tx}"` : "";
        first = false;
        const decoration = [runStyle.underline ? "underline" : "", runStyle.strike ? "line-through" : ""].filter(Boolean).join(" ");
        const baseline = runStyle.baseline > 0 ? "super" : runStyle.baseline < 0 ? "sub" : "baseline";
        return `<tspan${position} fill="${escapeXml(resolveColor(runStyle.color ?? "#000000", theme))}" font-family="${escapeXml(family)}" font-size="${Number(runStyle.fontSize ?? baseSize)}" font-weight="${runStyle.bold ? 700 : 400}" font-style="${runStyle.italic ? "italic" : "normal"}" text-decoration="${decoration || "none"}" baseline-shift="${baseline}" letter-spacing="${Number(runStyle.letterSpacing ?? 0)}"${runStyle.href ? ` data-href="${escapeXml(runStyle.href)}"` : ""}>${escapeXml(run.text)}</tspan>`;
      }).join("");
      const xml = `<text x="${tx}" y="${cursorY + maxSize}" text-anchor="${anchor}" dominant-baseline="alphabetic" data-rich-text="1" data-line-height="${lineHeight}">${runXml || `<tspan x="${tx}"> </tspan>`}</text>`;
      cursorY += lineHeight;
      return xml;
    }).join("");
    return lineBits;
  }).join("");
  const cx = x + w / 2; const cy = y + h / 2; const rotate = Number(element.rotation ?? element.rotate ?? 0); const sx = element.flip?.[0] || element.flipH ? -1 : 1; const sy = element.flip?.[1] || element.flipV ? -1 : 1; const transform = rotate || sx < 0 || sy < 0 ? ` transform="translate(${cx} ${cy}) rotate(${rotate}) scale(${sx} ${sy}) translate(${-cx} ${-cy})"` : "";
  const direction = content.textDirection === "vertical" ? ' style="writing-mode:vertical-rl"' : "";
  return `<g${transform} opacity="${Math.max(0, Math.min(1, Number(element.opacity ?? 1)))}"${direction}>${texts}</g>`;
}

function cropShapeSvg(shape, x, y, w, h) {
  if (!shape) return `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  const name = shape.shapeName === "circle" ? "ellipse" : shape.shapeName;
  if (name === "custom" && shape.path) {
    const viewBox = shape.viewBox ?? [100, 100];
    return `<path d="${escapeXml(shape.path)}" transform="translate(${x} ${y}) scale(${w / Number(viewBox[0] || 100)} ${h / Number(viewBox[1] || 100)})"/>`;
  }
  const paths = name && ECMA_PRESET_GEOMETRIES[name] ? ecmaPresetPaths(name, w, h, shape.adjustments ?? SHAPE_ADJUSTMENTS[name]) : null;
  if (paths?.length) return paths.filter((path) => path.d.length && path.fill !== "none").map((path) => `<path d="${escapeXml(path.d.join(" "))}" transform="translate(${x} ${y})"/>`).join("");
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
}

function renderImage(element, theme, resourceResolver, defs = [], imageIndex = 0) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const source = element.src ?? element.fill?.src;
  const href = imageHref(source, resourceResolver);
  if (!href) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e5e7eb"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" fill="#6b7280" font-size="12">资源未本地化</text>`;
  const crop = normalizedImageCrop(element.crop);
  const viewBox = `${crop.left * 100} ${crop.top * 100} ${crop.width * 100} ${crop.height * 100}`;
  const id = svgId(`${element.elementId ?? "image"}-${imageIndex}`);
  let clip = "";
  if (element.cropShape) {
    const clipId = `${id}-clip`;
    defs.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${cropShapeSvg(element.cropShape, x, y, w, h)}</clipPath>`);
    clip = ` clip-path="url(#${clipId})"`;
  }
  let filter = "";
  if (element.shadow) {
    const filterId = `${id}-shadow`;
    const shadow = element.shadow;
    const color = resolveColor(shadow.color ?? "#000000", theme);
    const offset = Array.isArray(shadow.offset) ? shadow.offset : [0, 0];
    defs.push(`<filter id="${filterId}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="${Number(offset[0] ?? 0)}" dy="${Number(offset[1] ?? 0)}" stdDeviation="${Math.max(0, Number(shadow.blur ?? 4) / 2)}" flood-color="${escapeXml(color)}" flood-opacity="${Math.max(0, Math.min(1, Number(colorParts(color, theme).alpha == null ? 1 : colorParts(color, theme).alpha / 255)))}"/></filter>`);
    filter = ` filter="url(#${filterId})"`;
  }
  const opacity = Math.max(0, Math.min(1, Number(element.opacity ?? 1)));
  const image = `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="${imagePreserveAspectRatio(element.fit?.mode)}" overflow="hidden"><image href="${escapeXml(href)}" x="0" y="0" width="100" height="100" preserveAspectRatio="none"/></svg>`;
  const border = element.border ? element.cropShape ? `<g fill="none" stroke="${escapeXml(resolveColor(element.border.color ?? "#000000", theme))}" stroke-width="${Number(element.border.width ?? 1)}">${cropShapeSvg(element.cropShape, x, y, w, h)}</g>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${escapeXml(resolveColor(element.border.color ?? "#000000", theme))}" stroke-width="${Number(element.border.width ?? 1)}"/>` : "";
  const transformed = `<g opacity="${opacity}"${clip}${filter}>${image}${border}</g>`;
  return wrapSvgTransform(element, transformed);
}

function renderTable(element, theme, defs = [], resourceResolver) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const model = normalizeTableGrid(element);
  const columnWidths = normalizedRatios(element.columnWidths, model.columnCount);
  const rowHeights = normalizedRatios(element.rowHeights, model.rowCount);
  const columnOffsets = columnWidths.reduce((items, ratio) => [...items, items.at(-1) + ratio * w], [x]);
  const rowOffsets = rowHeights.reduce((items, ratio) => [...items, items.at(-1) + ratio * h], [y]);
  const bits = [];
  model.grid.forEach((row, r) => row.forEach((entry, c) => {
    if (entry.hMerge || entry.vMerge) return;
    const cx = columnOffsets[c]; const cy = rowOffsets[r];
    const cw = columnOffsets[Math.min(model.columnCount, c + entry.colSpan)] - cx;
    const ch = rowOffsets[Math.min(model.rowCount, r + entry.rowSpan)] - cy;
    const style = resolveTableCellStyle(element, entry.cell, r, c, model.rowCount, model.columnCount, theme);
    const fillValue = fillSvg(style.fill, theme, `table-${element.elementId ?? "table"}-${r}-${c}`, resourceResolver, defs);
    let fill = fillValue;
    if (fillValue.includes("|")) {
      const [url, stops, x2, y2, gradientType] = fillValue.split("|");
      const gradientId = `table-${svgId(element.elementId ?? "table")}-${r}-${c}-gradient-${Math.round(Number(style.fill?.angle) || 0)}`;
      defs.push(gradientType === "radial" ? `<radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>` : `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`);
      fill = url;
    }
    const border = borderSides(style.border)[0];
    bits.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="${escapeXml(fill)}"${border ? ` stroke="${escapeXml(resolveColor(border.color ?? "#000000", theme))}" stroke-width="${Number(border.width ?? 1)}"` : ""}/>`);
    bits.push(renderText({ bounds: [cx + 4, cy + 2, Math.max(0, cw - 8), Math.max(0, ch - 4)], content: { ...style, text: entry.cell.text ?? "", align: style.align ?? ["center", "middle"] } }, theme));
  }));
  return bits.join("");
}

const CHART_TYPES = ["bar", "line", "area", "scatter", "bubble", "candlestick", "pie", "radar", "waterfall", "heatmap", "treemap", "sunburst", "sankey"];

function mergeSeriesDefaults(chart, series) {
  const defaults = chart.seriesDefaults?.[series.type] ?? {};
  const result = { ...defaults, ...series };
  for (const key of Object.keys(result)) if (defaults[key] && series[key] && !Array.isArray(series[key]) && typeof defaults[key] === "object" && typeof series[key] === "object") result[key] = { ...defaults[key], ...series[key] };
  return result;
}

function chartModel(element) {
  const chart = element.chart ?? element;
  const sourceCols = Array.isArray(chart.data?.cols) ? chart.data.cols.map(String) : [];
  const sourceRows = Array.isArray(chart.data?.rows) ? chart.data.rows : [];
  const cols = [...sourceCols];
  const rows = sourceRows.map((row) => [...(Array.isArray(row) ? row : [])]);
  const sourceSeries = (Array.isArray(chart.series) ? chart.series : []).map((item) => mergeSeriesDefaults(chart, item));
  const helperName = (seriesIndex, channel) => {
    const base = `__pptd_s${seriesIndex + 1}_${channel}`;
    let name = base; let suffix = 2;
    while (cols.includes(name)) name = `${base}_${suffix++}`;
    return name;
  };
  const series = sourceSeries.map((raw, seriesIndex) => {
    let item = { ...raw, encode: { ...(raw.encode ?? {}) } };
    if (item.dataFilter && sourceCols.includes(item.dataFilter.col)) {
      const filterColumn = sourceCols.indexOf(item.dataFilter.col);
      for (const [channel, column] of Object.entries(item.encode)) {
        const sourceColumn = sourceCols.indexOf(column);
        if (sourceColumn < 0) continue;
        const helper = helperName(seriesIndex, channel);
        cols.push(helper);
        rows.forEach((row, rowIndex) => row.push(sourceRows[rowIndex]?.[filterColumn] === item.dataFilter.value ? sourceRows[rowIndex]?.[sourceColumn] ?? null : null));
        item.encode[channel] = helper;
      }
    }
    if (item.type === "bubble" && item.sizeScale === "log" && cols.includes(item.encode.size)) {
      const sourceColumn = cols.indexOf(item.encode.size); const helper = helperName(seriesIndex, "logSize");
      cols.push(helper); rows.forEach((row) => row.push(row[sourceColumn] == null ? null : Math.log1p(Math.max(0, Number(row[sourceColumn]) || 0)))); item.encode.size = helper;
    }
    if (item.type === "waterfall" && cols.includes(item.encode.y)) {
      const valueColumn = cols.indexOf(item.encode.y); const totalColumn = item.encode.isTotal ? cols.indexOf(item.encode.isTotal) : -1;
      const baseColumn = helperName(seriesIndex, "waterfallBase"); const displayColumn = helperName(seriesIndex, "waterfallValue");
      cols.push(baseColumn, displayColumn); let running = 0;
      rows.forEach((row) => {
        const value = Number(row[valueColumn]) || 0; const total = totalColumn >= 0 && row[totalColumn] === true;
        const next = total ? value : running + value; row.push(total ? 0 : Math.min(running, next), total ? Math.abs(value) : Math.abs(value)); running = next;
      });
      item = { ...item, stack: "value", _waterfallSourceY: item.encode.y, _waterfallBase: baseColumn, encode: { ...item.encode, y: displayColumn } };
    }
    return item;
  });
  const objects = rows.map((row) => Object.fromEntries(cols.map((column, index) => [column, row?.[index] ?? null])));
  return { chart, cols, rows, objects, series, sourceCols, sourceRows, sourceSeries };
}

function validateChartElement(element) {
  const issues = []; const error = (message) => issues.push({ level: "error", message }); const warning = (message) => issues.push({ level: "warning", message });
  const model = chartModel(element); const { chart, cols, sourceCols, sourceRows, series, objects } = model;
  if (!sourceCols.length || new Set(sourceCols).size !== sourceCols.length || sourceCols.some((column) => !column.trim())) error("chart.data.cols 必须是非空且不重复的列名");
  sourceRows.forEach((row, index) => { if (!Array.isArray(row) || row.length !== sourceCols.length) error(`chart.data.rows[${index}] 长度必须等于 cols.length`); });
  if (!series.length) error("chart.series 至少需要一个系列");
  for (const [type, defaults] of Object.entries(chart.seriesDefaults ?? {})) {
    if (!["bar", "line", "area", "scatter", "bubble", "candlestick", "radar"].includes(type)) error(`seriesDefaults.${type} 不受支持`);
    if (defaults?.type != null || defaults?.encode != null) error(`seriesDefaults.${type} 不能包含 type 或 encode`);
  }
  for (const [field, min, max, minExclusive = false] of [["barWidth", 0, 1, true], ["barGap", 0, 1], ["categoryGap", 0, 1]]) {
    if (chart[field] != null && (!Number.isFinite(Number(chart[field])) || (minExclusive ? Number(chart[field]) <= min : Number(chart[field]) < min) || Number(chart[field]) >= max + (field === "barWidth" ? 1e-12 : 0))) error(`${field} 超出允许范围`);
  }
  const validateLineStyle = (value, path, withArrow = false) => {
    if (value == null || typeof value === "boolean") return;
    if (typeof value !== "object" || Array.isArray(value)) { error(`${path} 必须是 boolean 或配置对象`); return; }
    if (value.style != null && !["solid", "dash", "dot"].includes(value.style)) error(`${path}.style 不受支持`);
    if (value.width != null && !(Number(value.width) > 0)) error(`${path}.width 必须大于 0`);
    if (withArrow && value.arrow != null && ![true, false, "start", "end", "both"].includes(value.arrow)) error(`${path}.arrow 不受支持`);
  };
  const validateAxis = (value, path) => {
    for (const [index, axis] of (Array.isArray(value) ? value : [value]).entries()) {
      if (axis == null) continue; const prefix = Array.isArray(value) ? `${path}[${index}]` : path;
      if (typeof axis !== "object" || Array.isArray(axis)) { error(`${prefix} 必须是配置对象`); continue; }
      if (axis.type != null && !["category", "value"].includes(axis.type)) error(`${prefix}.type 不受支持`);
      if (axis.min != null && !Number.isFinite(Number(axis.min)) || axis.max != null && !Number.isFinite(Number(axis.max))) error(`${prefix}.min/max 必须是有限数值`);
      if (axis.min != null && axis.max != null && Number(axis.min) > Number(axis.max)) error(`${prefix}.min 不能大于 max`);
      validateLineStyle(axis.axisLine, `${prefix}.axisLine`, true); validateLineStyle(axis.gridLine, `${prefix}.gridLine`);
    }
  };
  validateAxis(chart.xAxis, "xAxis"); validateAxis(chart.yAxis, "yAxis");
  validateLineStyle(chart.spokeAxis?.axisLine, "spokeAxis.axisLine"); validateLineStyle(chart.spokeAxis?.gridLine, "spokeAxis.gridLine");
  if (chart.spokeAxis?.min != null && chart.spokeAxis?.max != null && Number(chart.spokeAxis.min) > Number(chart.spokeAxis.max)) error("spokeAxis.min 不能大于 max");
  if (chart.legend && typeof chart.legend === "object" && chart.legend.position != null && !["top", "bottom", "left", "right"].includes(chart.legend.position)) error("legend.position 不受支持");
  const encodes = { bar: ["x", "y"], line: ["x", "y"], area: ["x", "y"], scatter: ["x", "y"], bubble: ["x", "y", "size"], candlestick: ["x", "high", "low", "close"], pie: ["category", "value"], radar: ["category", "y"], waterfall: ["x", "y"], heatmap: ["x", "y", "value"], treemap: ["category", "value"], sunburst: ["category", "value"], sankey: ["source", "target", "flow"] };
  const numeric = new Set(["y", "value", "open", "high", "low", "close", "size", "flow"]);
  for (const [index, item] of series.entries()) {
    if (!CHART_TYPES.includes(item.type)) { error(`chart.series[${index}].type 不受支持：${item.type}`); continue; }
    for (const channel of encodes[item.type]) if (!item.encode?.[channel]) error(`chart.series[${index}].encode.${channel} 缺失`);
    if (item.dataFilter && !sourceCols.includes(item.dataFilter.col)) error(`chart.series[${index}].dataFilter.col 引用了未知列：${item.dataFilter.col}`);
    for (const [channel, column] of Object.entries(item.encode ?? {})) {
      if (!cols.includes(column)) error(`chart.series[${index}].encode.${channel} 引用了未知列：${column}`);
      const numericChannel = numeric.has(channel) && !(item.type === "heatmap" && channel === "y") || (["scatter", "bubble"].includes(item.type) && channel === "x");
      if (numericChannel) objects.forEach((row, rowIndex) => { const value = row[column]; if (value != null && value !== "" && !Number.isFinite(Number(value))) error(`chart.data.rows[${rowIndex}].${column} 必须是数字`); });
    }
    const indexFields = [["xAxisIndex", chart.xAxis], ["yAxisIndex", chart.yAxis]];
    for (const [field, axes] of indexFields) { const axisIndex = Number(item[field] ?? 0); if (!Number.isInteger(axisIndex) || axisIndex < 0) error(`${field} 必须是非负整数`); else if (axisIndex > 0 && (!Array.isArray(axes) || axes.length <= axisIndex)) error(`${field}=${item[field]} 需要对应的轴配置数组`); }
    if (item.type === "scatter" && item.marker === false) error("scatter.marker 不能为 false");
    if (item.marker && typeof item.marker === "object") { if (item.marker.shape != null && !["circle", "rect", "diamond", "triangle"].includes(item.marker.shape)) error(`${item.type}.marker.shape 不受支持`); if (item.marker.size != null && !(Number(item.marker.size) > 0)) error(`${item.type}.marker.size 必须大于 0`); validateLineStyle(item.marker.border, `${item.type}.marker.border`); }
    if (item.lineStyle != null && !["solid", "dash", "dot"].includes(item.lineStyle)) error(`${item.type}.lineStyle 不受支持`);
    if (item.width != null && !(Number(item.width) > 0)) error(`${item.type}.width 必须大于 0`);
    if (item.nullHandling != null && !["zero", "gap", "connect"].includes(item.nullHandling)) error(`${item.type}.nullHandling 不受支持`);
    if (item.type === "bar" && item.stack != null && !["value", "percent"].includes(item.stack)) error("bar.stack 不受支持");
    if (item.type === "area" && item.stack != null && !["value", "percent", "stream"].includes(item.stack)) error("area.stack 不受支持");
    if (item.type === "bubble" && item.sizeRange != null && (!Array.isArray(item.sizeRange) || item.sizeRange.length !== 2 || item.sizeRange.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0) || Number(item.sizeRange[0]) > Number(item.sizeRange[1]))) error("bubble.sizeRange 必须是递增的两个非负数");
    if (item.type === "bubble" && item.sizeScale != null && !["linear", "sqrt", "log"].includes(item.sizeScale)) error("bubble.sizeScale 不受支持");
    if (item.type === "pie" && item.innerRadius != null && (Number(item.innerRadius) < 0 || Number(item.innerRadius) > 1)) error("pie.innerRadius 必须在 [0,1] 内");
    if (item.type === "pie" && item.startAngle != null && !Number.isFinite(Number(item.startAngle))) error("pie.startAngle 必须是有限数值");
    if (["treemap", "sunburst"].includes(item.type) && item.levels != null && (!Number.isInteger(Number(item.levels)) || Number(item.levels) <= 0)) error(`${item.type}.levels 必须是正整数`);
    if (["treemap", "sunburst"].includes(item.type)) {
      const categoryKey = item.encode?.category; const parentKey = item.encode?.parent; const names = objects.map((row) => String(row[categoryKey] ?? "")); const known = new Set(names);
      if (names.some((name) => !name.trim())) error(`${item.type}.category 不能为空`);
      if (known.size !== names.length) error(`${item.type}.category 必须唯一`);
      if (parentKey) {
        const parents = new Map(); objects.forEach((row, rowIndex) => { const name = names[rowIndex]; const raw = row[parentKey]; if (raw == null || raw === "") return; const parent = String(raw); if (!known.has(parent)) error(`${item.type} 节点 ${name} 引用了未知 parent：${parent}`); else if (parent === name) error(`${item.type} 节点 ${name} 不能以自身为 parent`); else parents.set(name, parent); });
        const visiting = new Set(); const visited = new Set(); const cycle = (name) => { if (visiting.has(name)) return true; if (visited.has(name)) return false; visiting.add(name); const parent = parents.get(name); const result = parent ? cycle(parent) : false; visiting.delete(name); visited.add(name); return result; };
        if (names.some(cycle)) error(`${item.type} parent 关系不能形成环`);
      }
    }
    if (item.type === "sankey" && item.nodeAlign != null && !["left", "right", "justify"].includes(item.nodeAlign)) error("sankey.nodeAlign 不受支持");
    if (item.type === "heatmap") {
      if (item.colorScale?.type === "diverging" && item.colorScheme?.length !== 3) error("diverging heatmap 的 colorScheme 必须恰好包含 3 个颜色");
      if (item.colorScale?.type !== "diverging" && item.colorScheme && item.colorScheme.length < 2) error("linear heatmap 的 colorScheme 至少需要 2 个颜色");
      if (item.colorScale?.type != null && !["linear", "diverging"].includes(item.colorScale.type)) error("heatmap.colorScale.type 不受支持");
      if (item.colorScale?.domain != null && (!Array.isArray(item.colorScale.domain) || item.colorScale.domain.length !== 2 || item.colorScale.domain.some((value) => !Number.isFinite(Number(value))) || Number(item.colorScale.domain[0]) >= Number(item.colorScale.domain[1]))) error("heatmap.colorScale.domain 必须是递增的两个有限数值");
      for (const channel of ["x", "y"]) objects.forEach((row, rowIndex) => { const value = row[item.encode[channel]]; if (value != null && typeof value !== "string") error(`heatmap.data.rows[${rowIndex}].${item.encode[channel]} 必须是字符串类别`); });
      if (item.colorbar && typeof item.colorbar === "object" && item.colorbar.position != null && !["top", "bottom", "left", "right"].includes(item.colorbar.position)) error("heatmap.colorbar.position 不受支持");
    }
    if (item.type === "waterfall" && item.encode?.isTotal) {
      let running = 0; let seenTotal = false; let delta = 0;
      model.sourceRows.forEach((row, rowIndex) => {
        const object = Object.fromEntries(sourceCols.map((column, columnIndex) => [column, row?.[columnIndex] ?? null])); const total = object[item.encode.isTotal]; const value = Number(object[item._waterfallSourceY ?? item.encode.y]) || 0;
        if (total != null && typeof total !== "boolean") error(`waterfall isTotal 在第 ${rowIndex + 1} 行必须是 boolean 或 null`);
        if (total === true) { if (seenTotal && Math.abs(value - (running + delta)) > 1e-9) warning(`waterfall 第 ${rowIndex + 1} 行总计值与累计值不一致`); running = value; delta = 0; seenTotal = true; } else delta += value;
      });
    }
    const allowedLabels = { pie: ["value", "percentage", "category"], waterfall: ["value", "category"], treemap: ["value", "category"], sunburst: ["value", "category"], sankey: ["value", "category"] }[item.type] ?? ["value"];
    const label = item.dataLabels?.content ?? chart.dataLabels?.content;
    if (label && !allowedLabels.includes(label)) error(`${item.type}.dataLabels.content 不支持 ${label}`);
  }
  const types = new Set(series.map((item) => item.type));
  const exclusive = ["pie", "radar", "waterfall", "heatmap", "treemap", "sunburst", "sankey"];
  for (const type of exclusive) if (types.has(type) && (type === "radar" ? [...types].some((item) => item !== "radar") : series.length !== 1)) error(`${type} 不能与其他图表类型混用`);
  if (types.has("candlestick") && [...types].some((item) => !["candlestick", "bar", "line", "area"].includes(item))) error("candlestick 只能与 bar/line/area 混用");
  for (const stackType of ["bar", "area"]) { const modes = new Set(series.filter((item) => item.type === stackType && item.stack).map((item) => item.stack)); if (modes.size > 1) error(`${stackType} 的 stack 模式必须一致`); }
  if (types.has("radar") && new Set(series.map((item) => item.encode?.category)).size > 1) error("radar 系列必须共用同一 category 列");
  if (types.has("sankey")) {
    const item = series[0]; const graph = new Map(); objects.forEach((row, rowIndex) => { const source = String(row[item.encode.source]); const target = String(row[item.encode.target]); if (Number(row[item.encode.flow]) < 0) error(`sankey.data.rows[${rowIndex}].${item.encode.flow} 不能为负数`); if (!graph.has(source)) graph.set(source, []); graph.get(source).push(target); });
    const visiting = new Set(); const visited = new Set(); const cycle = (node) => { if (visiting.has(node)) return true; if (visited.has(node)) return false; visiting.add(node); if ((graph.get(node) ?? []).some(cycle)) return true; visiting.delete(node); visited.add(node); return false; };
    if ([...graph.keys()].some(cycle)) error("sankey 数据必须是有向无环图");
  }
  return issues;
}

function seriesColor(series, index, theme, key = "fill") {
  const palette = Object.values(theme?.colors ?? {}).filter((value) => typeof value === "string" && /^#/.test(value));
  const value = series[key] ?? series.lineColor ?? palette[index % Math.max(1, palette.length)] ?? ["#1783FF", "#68B8A8", "#C9A86A", "#8C84C9"][index % 4];
  return resolveColor(Array.isArray(value) ? value[0] : typeof value === "object" ? value.color ?? value.stops?.[0]?.color : value, theme);
}

function svgPiePath(cx, cy, radius, start, end) {
  const point = (angle) => [cx + Math.sin(angle) * radius, cy - Math.cos(angle) * radius];
  const a = point(start); const b = point(end); const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${a[0]} ${a[1]} A ${radius} ${radius} 0 ${large} 1 ${b[0]} ${b[1]} Z`;
}

function interpolateChartColor(colors, ratio, theme) {
  const palette = (Array.isArray(colors) ? colors : [colors]).filter(Boolean);
  if (!palette.length) return "#1783FF";
  if (palette.length === 1) return resolveColor(palette[0], theme);
  const scaled = Math.max(0, Math.min(1, Number(ratio) || 0)) * (palette.length - 1);
  const index = Math.min(palette.length - 2, Math.floor(scaled)); const amount = scaled - index;
  const left = colorParts(palette[index], theme); const right = colorParts(palette[index + 1], theme);
  const channel = (hex, offset) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mixed = [0, 2, 4].map((offset) => Math.round(channel(left.hex, offset) + (channel(right.hex, offset) - channel(left.hex, offset)) * amount).toString(16).padStart(2, "0")).join("");
  return `#${mixed}`;
}

function effectiveDataLabels(chart, series) {
  if (!chart.dataLabels && !series.dataLabels) return null;
  if (series.dataLabels === false) return null;
  return { ...(typeof chart.dataLabels === "object" ? chart.dataLabels : {}), ...(typeof series.dataLabels === "object" ? series.dataLabels : {}) };
}

function hierarchyModel(model, series) {
  const categoryKey = series.encode?.category; const valueKey = series.encode?.value; const parentKey = series.encode?.parent;
  const nodes = model.objects.map((row, index) => ({ name: String(row[categoryKey] ?? ""), value: Math.max(0, Number(row[valueKey]) || 0), parentName: parentKey && row[parentKey] != null && row[parentKey] !== "" ? String(row[parentKey]) : null, index, children: [], depth: 1, rootIndex: 0 }));
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const roots = [];
  for (const node of nodes) { const parent = node.parentName ? byName.get(node.parentName) : null; if (parent && parent !== node) parent.children.push(node); else roots.push(node); }
  const seen = new Set();
  const assign = (node, depth, rootIndex) => { if (seen.has(node)) return; seen.add(node); node.depth = depth; node.rootIndex = rootIndex; node.children.forEach((child) => assign(child, depth + 1, rootIndex)); };
  roots.forEach((root, index) => assign(root, 1, index));
  for (const node of nodes) if (!seen.has(node)) { roots.push(node); assign(node, 1, roots.length - 1); }
  const total = (node, visiting = new Set()) => { if (visiting.has(node)) return node.value; if (node.value > 0) return node.value; visiting.add(node); const value = node.children.reduce((sum, child) => sum + total(child, visiting), 0); visiting.delete(node); return value; };
  return { nodes, roots, total, maxDepth: Math.max(1, ...nodes.map((node) => node.depth)) };
}

function hierarchyFill(series, node, theme) {
  const configured = series.fill;
  if (series.type === "sunburst") {
    // Sunburst palettes cycle by top-level branch, so descendants keep the
    // color family of their root rather than consuming the next palette slot.
    if (Array.isArray(configured) && configured.length) return configured[node.rootIndex % configured.length];
    return Array.isArray(configured) ? seriesColor({ fill: undefined }, node.rootIndex, theme) : configured ?? seriesColor({ fill: undefined }, node.rootIndex, theme);
  }
  const rootValue = Array.isArray(configured)
    ? Array.isArray(configured[0])
      ? (configured[node.rootIndex % configured.length] ?? [])[0]
      : configured[node.rootIndex % configured.length]
    : configured;
  const fallback = rootValue == null ? seriesColor({ fill: rootValue }, node.rootIndex, theme) : rootValue;
  const levelValues = Array.isArray(configured) && Array.isArray(configured[0]) ? (configured[node.rootIndex % configured.length] ?? []) : [];
  if (levelValues[node.depth - 1] != null) return levelValues[node.depth - 1];
  const start = levelValues.at(-1) != null ? levelValues.at(-1) : fallback;
  return deriveHierarchyFill(start, Math.max(0, node.depth - Math.max(1, levelValues.length || 1)), theme);
}

function deriveHierarchyColor(value, levels, theme) {
  const parts = colorParts(value, theme);
  const resolved = `#${parts.hex}`;
  if (!/^#[0-9a-f]{6}$/i.test(resolved) || !levels) return parts.alpha == null ? resolved : `${resolved}${parts.alpha.toString(16).padStart(2, "0")}`;
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(parts.hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(...rgb); const min = Math.min(...rgb); const lightness = (max + min) / 2;
  const delta = max - min; let saturation = 0; let hue = 0;
  if (delta > 0) {
    saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rgb[0]) hue = (rgb[1] - rgb[2]) / delta + (rgb[1] < rgb[2] ? 6 : 0);
    else if (max === rgb[1]) hue = (rgb[2] - rgb[0]) / delta + 2;
    else hue = (rgb[0] - rgb[1]) / delta + 4;
    hue /= 6;
  }
  const targetLightness = Math.max(0, lightness - .1 * levels);
  const hueToRgb = (p, q, t) => { let next = t; if (next < 0) next += 1; if (next > 1) next -= 1; if (next < 1 / 6) return p + (q - p) * 6 * next; if (next < 1 / 2) return q; if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6; return p; };
  const q = targetLightness < .5 ? targetLightness * (1 + saturation) : targetLightness + saturation - targetLightness * saturation; const p = 2 * targetLightness - q;
  const output = [hueToRgb(p, q, hue + 1 / 3), hueToRgb(p, q, hue), hueToRgb(p, q, hue - 1 / 3)].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("");
  return parts.alpha == null ? `#${output}` : `#${output}${parts.alpha.toString(16).padStart(2, "0")}`;
}

function deriveHierarchyFill(value, levels, theme) {
  if (!levels || value == null) return value;
  if (value && typeof value === "object" && value.type === "gradient" && Array.isArray(value.stops)) {
    return { ...value, stops: value.stops.map((stop) => ({ ...stop, color: deriveHierarchyColor(stop.color ?? "#000000", levels, theme) })) };
  }
  if (value && typeof value === "object" && value.color != null) return { ...value, color: deriveHierarchyColor(value.color, levels, theme) };
  return deriveHierarchyColor(value, levels, theme);
}

function hierarchyWeights(hierarchy, nodes) {
  const weights = nodes.map((node) => Math.max(0, Number(hierarchy.total(node)) || 0));
  const total = weights.reduce((sum, value) => sum + value, 0);
  // A completely empty hierarchy still needs a visible, deterministic layout.
  // Zero-valued siblings in a non-empty hierarchy must remain zero-sized instead
  // of receiving a second, implicit share of the positive total.
  if (total > 0) return { weights, total };
  return { weights: nodes.map(() => 1), total: nodes.length };
}

function svgFillForValue(value, theme, defs, id) {
  const rendered = fillSvg(value, theme, id);
  if (!rendered.includes("|")) return rendered;
  const [url, stops, x2, y2, gradientType] = rendered.split("|");
  const angle = Math.round(Number(value?.angle) || 0);
  const gradientId = `${id}-gradient-${angle}`;
  defs.push(gradientType === "radial" ? `<radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>` : `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`);
  return url;
}

function layoutTreemap(hierarchy, bounds, levels, visit) {
  const layout = (nodes, box, depth) => {
    if (!nodes.length || depth > levels) return;
    const { weights, total } = hierarchyWeights(hierarchy, nodes); let offset = depth % 2 ? box[0] : box[1];
    nodes.forEach((node, index) => {
      const ratio = total > 0 ? weights[index] / total : 0;
      const isLast = index === nodes.length - 1;
      const remaining = depth % 2 ? box[0] + box[2] - offset : box[1] + box[3] - offset;
      const span = isLast ? Math.max(0, remaining) : Math.max(0, (depth % 2 ? box[2] : box[3]) * ratio);
      const child = depth % 2 ? [offset, box[1], span, box[3]] : [box[0], offset, box[2], span];
      offset += span;
      visit(node, child);
      if (node.children.length && depth < levels) layout(node.children, [child[0] + 2, child[1] + 18, Math.max(0, child[2] - 4), Math.max(0, child[3] - 20)], depth + 1);
    });
  };
  layout(hierarchy.roots, bounds, 1);
}

function svgRingPath(cx, cy, inner, outer, start, end) {
  const point = (radius, angle) => [cx + Math.sin(angle) * radius, cy - Math.cos(angle) * radius];
  const span = Math.max(0, end - start); const a = point(outer, start);
  if (span >= Math.PI * 2 - 1e-9) {
    const b = point(outer, start + Math.PI); const outerArcs = `A ${outer} ${outer} 0 0 1 ${b[0]} ${b[1]} A ${outer} ${outer} 0 0 1 ${a[0]} ${a[1]}`;
    if (inner <= 0) return `M ${cx} ${cy} L ${a[0]} ${a[1]} ${outerArcs} Z`;
    const c = point(inner, start); const d = point(inner, start + Math.PI);
    return `M ${a[0]} ${a[1]} ${outerArcs} L ${c[0]} ${c[1]} A ${inner} ${inner} 0 0 0 ${d[0]} ${d[1]} A ${inner} ${inner} 0 0 0 ${c[0]} ${c[1]} Z`;
  }
  const b = point(outer, end); const c = point(inner, end); const d = point(inner, start); const large = span > Math.PI ? 1 : 0;
  if (inner <= 0) return `M ${cx} ${cy} L ${a[0]} ${a[1]} A ${outer} ${outer} 0 ${large} 1 ${b[0]} ${b[1]} Z`;
  return `M ${a[0]} ${a[1]} A ${outer} ${outer} 0 ${large} 1 ${b[0]} ${b[1]} L ${c[0]} ${c[1]} A ${inner} ${inner} 0 ${large} 0 ${d[0]} ${d[1]} Z`;
}

function layoutSunburst(hierarchy, center, radius, levels, visit) {
  const ring = radius / Math.max(1, levels); const layout = (nodes, start, end, depth) => {
    if (!nodes.length || depth > levels) return;
    const { weights, total } = hierarchyWeights(hierarchy, nodes); let angle = start;
    nodes.forEach((node, index) => {
      const isLast = index === nodes.length - 1;
      const next = isLast ? end : angle + (end - start) * (total > 0 ? weights[index] / total : 0);
      visit(node, ring * (depth - 1), ring * depth, angle, next, center);
      if (node.children.length && depth < levels) layout(node.children, angle, next, depth + 1);
      angle = next;
    });
  };
  layout(hierarchy.roots, 0, Math.PI * 2, 1);
}

function renderChart(element, theme, defs = [], chartIndex = 0) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const model = chartModel(element); const type = model.series[0]?.type ?? "bar";
  const title = typeof model.chart.title === "string" ? model.chart.title : model.chart.title?.text;
  const top = y + (title ? 28 : 8); const plotH = Math.max(1, h - (title ? 36 : 16));
  const bits = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeXml(resolveColor(model.chart.fill?.color ?? "#ffffff00", theme))}"${model.chart.border ? ` stroke="${escapeXml(resolveColor(model.chart.border.color ?? "#000000", theme))}"` : ""}/>`];
  if (title) bits.push(`<text x="${x + w / 2}" y="${y + 18}" text-anchor="middle" font-size="${Number(model.chart.title?.fontSize ?? 15)}" fill="${escapeXml(resolveColor(model.chart.title?.color ?? "#20242b", theme))}">${escapeXml(title)}</text>`);
  if (type === "pie") {
    const series = model.series[0] ?? {}; const category = series.encode?.category; const value = series.encode?.value; const values = model.objects.map((row) => Math.max(0, Number(row[value]) || 0)); const total = values.reduce((sum, item) => sum + item, 0) || 1; let angle = Number(series.startAngle ?? 0) * Math.PI / 180; const radius = Math.min(w, plotH) * .38;
    values.forEach((item, index) => { const next = angle + item / total * Math.PI * 2; bits.push(`<path d="${svgPiePath(x + w / 2, top + plotH / 2, radius, angle, next)}" fill="${escapeXml(seriesColor({ ...series, fill: Array.isArray(series.fill) ? series.fill[index % series.fill.length] : series.fill }, index, theme))}"/>`); if (series.dataLabels?.show) { const middle = (angle + next) / 2; bits.push(`<text x="${x + w / 2 + Math.sin(middle) * radius * .65}" y="${top + plotH / 2 - Math.cos(middle) * radius * .65}" text-anchor="middle" font-size="10">${escapeXml(series.dataLabels.content === "category" ? model.objects[index][category] : series.dataLabels.content === "percentage" ? `${Math.round(item / total * 100)}%` : item)}</text>`); } angle = next; });
    if (Number(series.innerRadius) > 0) bits.push(`<circle cx="${x + w / 2}" cy="${top + plotH / 2}" r="${radius * Number(series.innerRadius)}" fill="white"/>`);
    return bits.join("");
  }
  if (type === "heatmap") {
    const series = model.series[0]; const labels = effectiveDataLabels(model.chart, series); const xs = [...new Set(model.objects.map((row) => String(row[series.encode.x])))]; const ys = [...new Set(model.objects.map((row) => String(row[series.encode.y])))]; const values = model.objects.map((row) => Number(row[series.encode.value])).filter(Number.isFinite); const magnitude = Math.max(1, ...values.map(Math.abs)); const diverging = series.colorScale?.type === "diverging"; const min = series.colorScale?.domain?.[0] ?? (diverging ? -magnitude : Math.min(0, ...values)); const max = series.colorScale?.domain?.[1] ?? (diverging ? magnitude : Math.max(1, ...values)); const colors = series.colorScheme ?? (diverging ? ["#2563EB", "#F8FAFC", "#DC2626"] : ["#EFF6FF", "#1783FF"]); const colorbar = series.colorbar !== false && series.colorbar?.show !== false; const plotW = Math.max(1, w - (colorbar ? 44 : 0));
    model.objects.forEach((row) => { const xi = xs.indexOf(String(row[series.encode.x])); const yi = ys.indexOf(String(row[series.encode.y])); const value = Number(row[series.encode.value]); if (!Number.isFinite(value)) return; const ratio = Math.max(0, Math.min(1, (value - min) / Math.max(1e-9, max - min))); bits.push(`<rect x="${x + xi * plotW / xs.length}" y="${top + yi * plotH / ys.length}" width="${plotW / xs.length}" height="${plotH / ys.length}" fill="${escapeXml(interpolateChartColor(colors, ratio, theme))}"/>`); if (labels?.show) bits.push(`<text x="${x + (xi + .5) * plotW / xs.length}" y="${top + (yi + .55) * plotH / ys.length}" text-anchor="middle" font-size="${Number(labels.fontSize ?? 10)}" fill="${escapeXml(resolveColor(labels.color ?? "#111827", theme))}">${escapeXml(value)}</text>`); });
    if (colorbar) for (let index = 0; index < 20; index += 1) bits.push(`<rect x="${x + w - 24}" y="${top + index * plotH / 20}" width="10" height="${plotH / 20 + .5}" fill="${escapeXml(interpolateChartColor(colors, 1 - index / 19, theme))}"/>`);
    return bits.join("");
  }
  if (type === "treemap") {
    const series = model.series[0]; const hierarchy = hierarchyModel(model, series); const levels = Math.min(hierarchy.maxDepth, Number(series.levels) || hierarchy.maxDepth); const labels = effectiveDataLabels(model.chart, series);
    layoutTreemap(hierarchy, [x, top, w, plotH], levels, (node, box) => { const border = series.border ? ` stroke="${escapeXml(resolveColor(series.border.color ?? "#ffffff", theme))}" stroke-width="${Number(series.border.width ?? 1)}"` : ""; const fill = svgFillForValue(hierarchyFill(series, node, theme), theme, defs, `chart-${chartIndex}-treemap-${node.index}`); bits.push(`<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" fill="${escapeXml(fill)}"${border}/>`); if (labels?.show && box[2] > 24 && box[3] > 14) bits.push(`<text x="${box[0] + 5}" y="${box[1] + 13}" font-size="${Number(labels.fontSize ?? 10)}" fill="${escapeXml(resolveColor(labels.color ?? "#ffffff", theme))}">${escapeXml(labels.content === "value" ? node.value : node.name)}</text>`); }); return bits.join("");
  }
  if (type === "sunburst") {
    const series = model.series[0]; const hierarchy = hierarchyModel(model, series); const levels = Math.min(hierarchy.maxDepth, Number(series.levels) || hierarchy.maxDepth); const labels = effectiveDataLabels(model.chart, series); const center = [x + w / 2, top + plotH / 2]; const radius = Math.min(w, plotH) * .45;
    layoutSunburst(hierarchy, center, radius, levels, (node, inner, outer, start, end) => { const border = series.border ? ` stroke="${escapeXml(resolveColor(series.border.color ?? "#ffffff", theme))}" stroke-width="${Number(series.border.width ?? 1)}"` : ""; const fill = svgFillForValue(hierarchyFill(series, node, theme), theme, defs, `chart-${chartIndex}-sunburst-${node.index}`); bits.push(`<path d="${svgRingPath(center[0], center[1], inner, outer, start, end)}" fill="${escapeXml(fill)}"${border}/>`); if (labels?.show && end - start > .18) { const angle = (start + end) / 2; const r = (inner + outer) / 2; bits.push(`<text x="${center[0] + Math.sin(angle) * r}" y="${center[1] - Math.cos(angle) * r}" text-anchor="middle" font-size="${Number(labels.fontSize ?? 9)}" fill="${escapeXml(resolveColor(labels.color ?? "#ffffff", theme))}">${escapeXml(labels.content === "value" ? node.value : node.name)}</text>`); } }); return bits.join("");
  }
  if (type === "sankey") {
    const series = model.series[0]; const names = [...new Set(model.objects.flatMap((row) => [String(row[series.encode.source]), String(row[series.encode.target])]))]; const sources = new Set(model.objects.map((row) => String(row[series.encode.source]))); const left = names.filter((name) => sources.has(name)); const right = names.filter((name) => !sources.has(name)); const positions = new Map(); left.forEach((name, index) => positions.set(name, [x + 8, top + index * plotH / Math.max(1, left.length)])); right.forEach((name, index) => positions.set(name, [x + w - 24, top + index * plotH / Math.max(1, right.length)])); model.objects.forEach((row) => { const a = positions.get(String(row[series.encode.source])); const b = positions.get(String(row[series.encode.target])); if (a && b) bits.push(`<path d="M${a[0] + 16},${a[1] + 8} C${x + w / 2},${a[1] + 8} ${x + w / 2},${b[1] + 8} ${b[0]},${b[1] + 8}" fill="none" stroke="#94a3b8" stroke-width="${Math.max(1, Number(row[series.encode.flow]) || 1)}" opacity=".45"/>`); }); positions.forEach(([nx, ny], name) => bits.push(`<rect x="${nx}" y="${ny}" width="16" height="16" fill="#1783FF"/><text x="${nx + (nx < x + w / 2 ? 20 : -4)}" y="${ny + 12}" text-anchor="${nx < x + w / 2 ? "start" : "end"}" font-size="10">${escapeXml(name)}</text>`)); return bits.join("");
  }
  if (type === "radar") {
    const series = model.series[0]; const count = Math.max(3, model.objects.length); const values = model.objects.map((row) => Number(row[series.encode.y]) || 0); const max = Number(model.chart.spokeAxis?.max) || Math.max(1, ...values); const cx = x + w / 2; const cy = top + plotH / 2; const radius = Math.min(w, plotH) * .4; const points = values.map((value, index) => { const angle = index * Math.PI * 2 / count; return `${cx + Math.sin(angle) * radius * value / max},${cy - Math.cos(angle) * radius * value / max}`; }); bits.push(`<polygon points="${points.join(" ")}" fill="${escapeXml(seriesColor(series, 0, theme, "areaColor"))}" fill-opacity=".35" stroke="${escapeXml(seriesColor(series, 0, theme, "lineColor"))}"/>`); return bits.join("");
  }
  const numeric = model.series.flatMap((series) => model.objects.flatMap((row) => [series._waterfallBase, series.encode?.y, series.encode?.high, series.encode?.low, series.encode?.open, series.encode?.close].filter(Boolean).map((column) => Number(row[column])).filter(Number.isFinite))); const waterfallTops = model.series.filter((series) => series.type === "waterfall").flatMap((series) => model.objects.map((row) => Number(row[series._waterfallBase]) + Number(row[series.encode.y])).filter(Number.isFinite)); const min = Math.min(0, ...numeric, ...waterfallTops); const max = Math.max(1, ...numeric, ...waterfallTops); const sy = (value) => top + plotH - (Number(value) - min) / Math.max(1e-9, max - min) * plotH;
  const xValues = model.series.filter((series) => ["scatter", "bubble"].includes(series.type)).flatMap((series) => model.objects.map((row) => Number(row[series.encode.x])).filter(Number.isFinite)); const xMin = Math.min(0, ...xValues); const xMax = Math.max(1, ...xValues); const sx = (value) => x + (Number(value) - xMin) / Math.max(1e-9, xMax - xMin) * w;
  const markerSvg = (cx, cy, radius, shape, fill, border) => { const stroke = border ? ` stroke="${escapeXml(resolveColor(border.color ?? "#000000", theme))}" stroke-width="${Number(border.width ?? 1)}"` : ""; const color = escapeXml(resolveColor(fill, theme)); if (shape === "rect") return `<rect x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" fill="${color}"${stroke}/>`; if (shape === "diamond") return `<path d="M ${cx} ${cy - radius} L ${cx + radius} ${cy} L ${cx} ${cy + radius} L ${cx - radius} ${cy} Z" fill="${color}"${stroke}/>`; if (shape === "triangle") return `<path d="M ${cx} ${cy - radius} L ${cx + radius} ${cy + radius} L ${cx - radius} ${cy + radius} Z" fill="${color}"${stroke}/>`; return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"${stroke}/>`; };
  model.series.forEach((series, seriesIndex) => {
    const color = seriesColor(series, seriesIndex, theme); const values = model.objects.map((row) => Number(row[series.encode?.y ?? series.encode?.close ?? series.encode?.value]));
    if (series.type === "bar") values.forEach((value, index) => { const slot = w / Math.max(1, values.length); const width = slot * Number(model.chart.barWidth ?? .65) / Math.max(1, model.series.length); bits.push(`<rect x="${x + index * slot + seriesIndex * width}" y="${sy(Math.max(0, value))}" width="${width}" height="${Math.abs(sy(value) - sy(0))}" fill="${escapeXml(color)}"/>`); });
    else if (series.type === "waterfall") values.forEach((value, index) => { const row = model.objects[index]; const base = Number(row[series._waterfallBase]) || 0; const source = Number(row[series._waterfallSourceY]) || 0; const total = series.encode.isTotal && row[series.encode.isTotal] === true; const role = total ? series.totalBars : source >= 0 ? series.increaseBars : series.decreaseBars; const slot = w / Math.max(1, values.length); const width = slot * Number(model.chart.barWidth ?? .65); const fill = seriesColor({ fill: role?.fill ?? (total ? "#64748B" : source >= 0 ? "#16A34A" : "#DC2626") }, index, theme); bits.push(`<rect x="${x + index * slot + (slot - width) / 2}" y="${sy(base + value)}" width="${width}" height="${Math.max(1, Math.abs(sy(base) - sy(base + value)))}" fill="${escapeXml(fill)}"/>`); });
    else if (["line", "area"].includes(series.type)) { const points = values.map((value, index) => `${x + (index + .5) * w / Math.max(1, values.length)},${sy(value)}`).join(" "); if (series.type === "area") bits.push(`<polygon points="${x},${sy(0)} ${points} ${x + w},${sy(0)}" fill="${escapeXml(seriesColor(series, seriesIndex, theme, "areaColor"))}" opacity=".35"/>`); bits.push(`<polyline points="${points}" fill="none" stroke="${escapeXml(color)}" stroke-width="${Number(series.width ?? 2)}"${series.lineStyle === "dash" ? ' stroke-dasharray="8 5"' : series.lineStyle === "dot" ? ' stroke-dasharray="2 4"' : ""}/>`); if (series.marker && series.marker !== false) values.forEach((value, index) => bits.push(markerSvg(x + (index + .5) * w / Math.max(1, values.length), sy(value), Number(series.marker.size ?? 4), series.marker.shape, series.marker.fill ?? color, series.marker.border))); }
    else if (["scatter", "bubble"].includes(series.type)) { const rawSizes = model.objects.map((row) => Math.max(0, Number(row[series.encode.size]) || 0)); const sizes = rawSizes.map((value) => series.sizeScale === "linear" || series.sizeScale === "log" ? value : Math.sqrt(value)); const sizeMin = Math.min(...sizes); const sizeMax = Math.max(...sizes); const range = series.sizeRange ?? [3, Math.max(6, Math.min(w, plotH) * .06)]; const radius = (value) => Number(range[0]) + (Number(range[1]) - Number(range[0])) * (value - sizeMin) / Math.max(1e-9, sizeMax - sizeMin); const labels = effectiveDataLabels(model.chart, series); model.objects.forEach((row, index) => { const vx = Number(row[series.encode.x]); const vy = Number(row[series.encode.y]); if (!Number.isFinite(vx) || !Number.isFinite(vy)) return; const r = series.type === "bubble" ? radius(sizes[index]) : Number(series.marker?.size ?? 5); const marker = series.type === "scatter" ? series.marker ?? {} : {}; bits.push(markerSvg(sx(vx), sy(vy), Math.max(1, r), marker.shape, marker.fill ?? color, marker.border ?? series.border)); if (labels?.show) bits.push(`<text x="${sx(vx)}" y="${sy(vy) - r - 3}" text-anchor="middle" font-size="${Number(labels.fontSize ?? 9)}" fill="${escapeXml(resolveColor(labels.color ?? "#111827", theme))}">${escapeXml(vy)}</text>`); }); }
    else if (series.type === "candlestick") model.objects.forEach((row, index) => { const slot = w / Math.max(1, model.objects.length); const cx = x + (index + .5) * slot; const open = Number(row[series.encode.open]); const close = Number(row[series.encode.close]); const high = Number(row[series.encode.high]); const low = Number(row[series.encode.low]); const wick = series.wickStyle ?? {}; const wickColor = resolveColor(wick.color ?? "#374151", theme); bits.push(`<line x1="${cx}" y1="${sy(high)}" x2="${cx}" y2="${sy(low)}" stroke="${escapeXml(wickColor)}" stroke-width="${Number(wick.width ?? 1)}"/>`); if (Number.isFinite(open)) { const role = close > open ? series.upBars : series.downBars; bits.push(`<rect x="${cx - slot * .25}" y="${sy(Math.max(open, close))}" width="${slot * .5}" height="${Math.max(1, Math.abs(sy(open) - sy(close)))}" fill="${escapeXml(resolveColor(role?.fill ?? (close > open ? "#16a34a" : "#dc2626"), theme))}"${role?.border ? ` stroke="${escapeXml(resolveColor(role.border.color ?? "#000000", theme))}" stroke-width="${Number(role.border.width ?? 1)}"` : ""}/>`); } else bits.push(markerSvg(cx, sy(close), 3, "circle", series.upBars?.fill ?? "#2563EB", series.wickStyle)); });
  });
  return bits.join("");
}

export function renderPageSvg(page, { size = [960, 540], theme = {}, resourceResolver, includeMetadata = true, includeElementMetadata = false } = {}) {
  const width = Number(size?.[0] ?? 960); const height = Number(size?.[1] ?? 540);
  const defs = [];
  const background = page?.background;
  const bgColor = background?.type === "solid" || background?.color ? resolveColor(background.color ?? "#ffffff", theme) : "#ffffff";
  const body = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(bgColor)}"/>`];
  if (background?.type === "image" || background?.src) body.push(renderImage({ ...background, bounds: [0, 0, width, height] }, theme, resourceResolver, defs, "background"));
  for (const [index, element] of (page?.elements ?? []).entries()) {
    const type = element.elementType ?? element.type;
    let markup;
    if (type === "text" || type === "formula") markup = renderText(element, theme);
    else if (type === "shape") markup = renderShape(element, theme, defs, index, resourceResolver);
    else if (type === "line") markup = renderLine(element, theme);
    else if (type === "image") markup = renderImage(element, theme, resourceResolver, defs, index);
    else if (type === "table") markup = renderTable(element, theme, defs, resourceResolver);
    else if (type === "chart") markup = renderChart(element, theme, defs, index);
    else if (type === "icon") markup = renderText({ ...element, content: { ...(element.content ?? {}), text: element.icon ?? "◆" } }, theme);
    else markup = renderShape(element, theme, defs, index, resourceResolver);
    if (includeElementMetadata) {
      const elementId = element.elementId == null ? "" : ` data-element-id="${escapeXml(element.elementId)}"`;
      markup = `<g${elementId} data-element-index="${index}">${markup}</g>`;
    }
    body.push(markup);
  }
  const metadata = includeMetadata ? `<!-- PPTD local renderer; pageType=${escapeXml(page?.pageType ?? "content")} -->` : "";
  return `${metadata}<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join("")}</defs>${body.join("")}</svg>`;
}

const ANIMATION_EFFECTS = ["appear", "fade-in", "fly-in", "zoom-in", "wipe-in", "float-in", "peek-in", "rise-in", "pulse", "grow-shrink", "spin", "teeter", "fill-color", "transparency", "color-pulse", "disappear", "fade-out", "fly-out", "zoom-out", "wipe-out", "float-out", "motion-path"];
const ANIMATION_TRIGGERS = ["onClick", "withPrevious", "afterPrevious"];

function validateAnimations(page) {
  const issues = []; const elements = new Set((page.elements ?? []).map((element) => element.elementId).filter(Boolean));
  for (const [index, animation] of (page.animations ?? []).entries()) {
    const prefix = `animations[${index}]`;
    if (!elements.has(animation.elementId)) issues.push(`${prefix}.elementId 未引用当前页面元素：${animation.elementId}`);
    if (!ANIMATION_EFFECTS.includes(animation.effect)) issues.push(`${prefix}.effect 不受支持：${animation.effect}`);
    if (animation.trigger != null && !ANIMATION_TRIGGERS.includes(animation.trigger)) issues.push(`${prefix}.trigger 不受支持：${animation.trigger}`);
    if (animation.durationMs != null && !(Number(animation.durationMs) > 0)) issues.push(`${prefix}.durationMs 必须大于 0`);
    if (animation.delayMs != null && !(Number(animation.delayMs) >= 0)) issues.push(`${prefix}.delayMs 不能为负数`);
    if (animation.repeat != null && (!Number.isInteger(Number(animation.repeat)) || Number(animation.repeat) <= 0)) issues.push(`${prefix}.repeat 必须是正整数`);
    if (animation.easing != null && !["linear", "ease-in", "ease-out", "ease-in-out"].includes(animation.easing)) issues.push(`${prefix}.easing 不受支持：${animation.easing}`);
    if (animation.direction != null && !["up", "down", "left", "right"].includes(animation.direction)) issues.push(`${prefix}.direction 不受支持：${animation.direction}`);
    if (["float-in", "float-out"].includes(animation.effect) && animation.direction != null && !["up", "down"].includes(animation.direction)) issues.push(`${prefix}.${animation.effect} 只支持 up/down`);
    if (animation.effect === "motion-path" && (typeof animation.path !== "string" || !/^\s*M\s*0(?:\.0+)?[ ,]+0(?:\.0+)?(?:\s|$)/i.test(animation.path) || /[AHVST]/i.test(animation.path))) issues.push(`${prefix}.motion-path 需要以 M 0 0 开始且仅包含 M/L/Q/C/Z`);
    if (["fill-color", "color-pulse"].includes(animation.effect) && !/^#?[0-9a-f]{6}$/i.test(animation.color ?? "")) issues.push(`${prefix}.${animation.effect} 需要 6 位 HEX color`);
    if (animation.effect === "transparency" && !(Number(animation.amount) >= 0 && Number(animation.amount) <= 1)) issues.push(`${prefix}.transparency.amount 必须在 [0,1] 内`);
  }
  return issues;
}

function readManifest(manifestPath) {
  const path = resolve(manifestPath);
  if (!existsSync(path)) throw new Error(`找不到 PPTD 清单：${manifestPath}`);
  const source = readFileSync(path, "utf8");
  let data;
  try { data = parseYaml(source); } catch (error) { throw new Error(`${path}: ${error.message}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("PPTD 清单必须是对象");
  return { path, source, data };
}

export function findManifest(input) {
  const path = resolve(input);
  if (statSync(path, { throwIfNoEntry: false })?.isFile()) {
    if (!path.toLowerCase().endsWith(".pptd")) throw new Error(`输入必须是 .pptd 文件或项目目录：${input}`);
    return path;
  }
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`输入不存在：${input}`);
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSafe(directory)) {
      const child = resolve(directory, name);
      const stats = statSync(child);
      if (stats.isDirectory() && name !== "node_modules" && name !== ".git") walk(child);
      else if (stats.isFile() && name.toLowerCase().endsWith(".pptd")) entries.push(child);
    }
  };
  walk(path);
  if (!entries.length) throw new Error(`目录中没有 .pptd 清单：${input}`);
  if (entries.length > 1) throw new Error(`发现多个 .pptd 清单，请明确指定文件：\n${entries.slice(0, 20).join("\n")}`);
  return entries[0];
}

function readdirSafe(directory) {
  // Kept as a tiny lazy import boundary so browser bundlers can tree-shake the
  // filesystem half of the module.  Node calls this branch only.
  return readdirSync(directory);
}

function pagePathInside(root, pagePath) {
  if (typeof pagePath !== "string" || !pagePath.trim()) throw new Error("pages 必须包含非空相对路径");
  if (/^(?:[a-z]+:|\/|[A-Za-z]:[\\/])/.test(pagePath) || pagePath.split(/[\\/]+/).includes("..")) throw new Error(`页面路径越过项目目录：${pagePath}`);
  const path = resolve(root, pagePath);
  if (relative(root, path).startsWith("..")) throw new Error(`页面路径越过项目目录：${pagePath}`);
  return path;
}

function resourcePathInside(root, resourcePath) {
  if (typeof resourcePath !== "string" || !resourcePath.trim()) throw new Error("资源路径必须是非空相对路径");
  if (/^(?:[a-z]+:|\/|[A-Za-z]:[\\/])/i.test(resourcePath) || resourcePath.split(/[\\/]+/).includes("..")) throw new Error(`资源路径越过项目目录：${resourcePath}`);
  const path = resolve(root, resourcePath);
  if (relative(root, path).startsWith("..")) throw new Error(`资源路径越过项目目录：${resourcePath}`);
  return path;
}

export function resolveProjectResource(root, resourcePath) {
  return resourcePathInside(root, resourcePath);
}

function collectImageResourceRefs(value, refs = [], context = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return refs;
  seen.add(value);
  const imageLike = value.elementType === "image" || value.type === "image" || context === "background" || context.endsWith(".fill");
  if (imageLike && typeof value.src === "string") refs.push({ src: value.src, context });
  for (const [key, child] of Object.entries(value)) if (child && typeof child === "object") collectImageResourceRefs(child, refs, context ? `${context}.${key}` : key, seen);
  return refs;
}

function collectImageNodes(value, nodes = [], context = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return nodes;
  seen.add(value);
  const imageLike = value.elementType === "image" || value.type === "image" || context === "background" || context.endsWith(".fill");
  if (imageLike) nodes.push({ value, context });
  for (const [key, child] of Object.entries(value)) if (child && typeof child === "object") collectImageNodes(child, nodes, context ? `${context}.${key}` : key, seen);
  return nodes;
}

function pageImageResourceRefs(page) {
  const refs = [];
  collectImageResourceRefs(page.data?.background, refs, "background");
  for (const [index, element] of (page.data?.elements ?? []).entries()) collectImageResourceRefs(element, refs, `elements[${index}]`);
  return refs;
}

function manifestImageResourceRefs(manifest) {
  return collectImageResourceRefs(manifest?.theme, [], "theme");
}

function resourceIsRemote(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function resourceIsInline(value) {
  return typeof value === "string" && /^data:/i.test(value);
}

function warnImageResources(refs, warnings, root, page = null) {
  for (const ref of refs) {
    const resource = ref.src;
    if (resourceIsRemote(resource)) {
      warnings.push({ level: "warning", code: "remote-resource", page, element: ref.context, message: "远程图片尚未本地化" });
      continue;
    }
    if (resourceIsInline(resource) || !root) continue;
    try {
      const path = resourcePathInside(root, resource);
      if (!existsSync(path) || !statSync(path).isFile()) warnings.push({ level: "error", code: "resource-missing", page, element: ref.context, message: `找不到本地资源：${resource}` });
    } catch (error) {
      warnings.push({ level: "error", code: "resource-path", page, element: ref.context, message: error.message });
    }
  }
}

export function loadProject(input) {
  const manifestPath = findManifest(input);
  const manifest = readManifest(manifestPath);
  const root = resolve(manifestPath, "..");
  if (manifest.data.version && manifest.data.version !== "v2") throw new Error(`仅支持 PPTD v2，当前为 ${manifest.data.version}`);
  const pageEntries = manifest.data.pages;
  if (!Array.isArray(pageEntries) || pageEntries.length === 0) throw new Error("PPTD 清单缺少非空 pages 列表");
  const pages = pageEntries.map((entry, index) => {
    const pagePath = pagePathInside(root, entry);
    if (!existsSync(pagePath)) throw new Error(`缺少页面文件：${entry}`);
    const source = readFileSync(pagePath, "utf8");
    let data;
    try { data = parseYaml(source); } catch (error) { throw new Error(`${pagePath}: ${error.message}`); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`页面必须是对象：${entry}`);
    if (!Array.isArray(data.elements)) data.elements = [];
    return { path: entry, absolutePath: pagePath, source, data, index };
  });
  return { root, manifestPath, manifestSource: manifest.source, manifest: manifest.data, pages, size: manifest.data.size ?? [960, 540], title: manifest.data.title ?? basename(manifestPath, ".pptd") };
}

function warnPage(page, warnings, size = [960, 540], root = null) {
  const imageNodes = [];
  collectImageNodes(page.data?.background, imageNodes, "background");
  for (const [index, element] of (page.data?.elements ?? []).entries()) collectImageNodes(element, imageNodes, `elements[${index}]`);
  for (const { value, context } of imageNodes) {
    const mode = value.fit?.mode;
    if (mode != null && !["cover", "contain", "fill"].includes(mode)) warnings.push({ level: "error", code: "image-fit", page: page.path, element: context, message: `图片 fit.mode 不受支持：${mode}` });
    const rawCrop = value.crop ?? {};
    const left = Number(rawCrop.left ?? 0); const right = Number(rawCrop.right ?? 0); const top = Number(rawCrop.top ?? 0); const bottom = Number(rawCrop.bottom ?? 0);
    if (![left, right, top, bottom].every(Number.isFinite) || left + right >= 1 || top + bottom >= 1) warnings.push({ level: "error", code: "image-crop", page: page.path, element: context, message: "图片 crop 会导致源矩形退化" });
    if (value.opacity != null && (!Number.isFinite(Number(value.opacity)) || Number(value.opacity) < 0 || Number(value.opacity) > 1)) warnings.push({ level: "error", code: "image-opacity", page: page.path, element: context, message: "图片 opacity 必须在 [0,1] 内" });
  }
  warnImageResources(pageImageResourceRefs(page), warnings, root, page.path);
  for (const element of page.data.elements ?? []) {
    const bounds = element.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some((item) => !Number.isFinite(Number(item)))) warnings.push({ level: "error", code: "invalid-bounds", page: page.path, element: element.elementId ?? null, message: "bounds 必须是四个数字" });
    else if (bounds[2] < 0 || bounds[3] < 0) warnings.push({ level: "error", code: "negative-size", page: page.path, element: element.elementId ?? null, message: "元素宽高不能为负数" });
    else if (bounds[0] < 0 || bounds[1] < 0 || bounds[0] + bounds[2] > Number(size[0] ?? 960) || bounds[1] + bounds[3] > Number(size[1] ?? 540)) warnings.push({ level: "warning", code: "overflow", page: page.path, element: element.elementId ?? null, message: "元素可能超出画布" });
    if (element.elementType === "shape") {
      if (element.shapeName === "custom") {
        if (!Array.isArray(element.viewBox) || element.viewBox.length !== 2 || typeof element.path !== "string" || !element.path.trim()) warnings.push({ level: "error", code: "custom-shape", page: page.path, element: element.elementId ?? null, message: "custom shape 需要有效的 viewBox 和 path" });
      } else if (!PRESET_SHAPE_NAMES.includes(element.shapeName) && element.shapeName !== "circle") warnings.push({ level: "error", code: "shape-name", page: page.path, element: element.elementId ?? null, message: `未知的 preset shape：${element.shapeName}` });
      const expected = SHAPE_ADJUSTMENTS[element.shapeName]?.length ?? 0;
      if (element.adjustments != null && (!Array.isArray(element.adjustments) || element.adjustments.length !== expected || element.adjustments.some((value) => !Number.isFinite(Number(value))))) warnings.push({ level: "error", code: "shape-adjustments", page: page.path, element: element.elementId ?? null, message: `${element.shapeName} adjustments 需要 ${expected} 个有限数值` });
    }
    if (element.elementType === "line") {
      const points = String(element.points ?? "").trim().split(/\s+/).filter(Boolean);
      if (!Array.isArray(element.viewBox) || element.viewBox.length !== 2 || points.length < 2 || points.some((point) => !/^-?(?:\d+(?:\.\d*)?|\.\d+),-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(point))) warnings.push({ level: "error", code: "line-path", page: page.path, element: element.elementId ?? null, message: "line 需要有效的 viewBox 和至少两个 x,y points" });
    }
    if (element.elementType === "table") {
      let tableModel = null;
      try { tableModel = normalizeTableGrid(element); } catch (error) { warnings.push({ level: "error", code: "table-merge", page: page.path, element: element.elementId ?? null, message: error.message }); }
      for (const [rowIndex, row] of (Array.isArray(element.rows) ? element.rows : []).entries()) for (const [cellIndex, cell] of (Array.isArray(row) ? row : []).entries()) for (const field of ["rowSpan", "colSpan"]) if (cell?.[field] != null && (!Number.isInteger(Number(cell[field])) || Number(cell[field]) < 1)) warnings.push({ level: "error", code: "table-merge", page: page.path, element: element.elementId ?? null, message: `rows[${rowIndex}][${cellIndex}].${field} 必须是正整数` });
      for (const [name, values, expected] of [["columnWidths", element.columnWidths, tableModel?.columnCount], ["rowHeights", element.rowHeights, tableModel?.rowCount]]) {
        if (!Array.isArray(values) || values.length !== expected || values.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) || Math.abs(values.reduce((sum, value) => sum + Number(value), 0) - 1) > 1e-6) warnings.push({ level: "error", code: "table-size", page: page.path, element: element.elementId ?? null, message: `${name} 必须包含 ${expected ?? 0} 个 [0,1] 内的有限数值且总和为 1` });
      }
    }
    if (element.elementType === "chart") for (const issue of validateChartElement(element)) warnings.push({ level: issue.level, code: issue.level === "warning" ? "chart-warning" : "chart", page: page.path, element: element.elementId ?? null, message: issue.message });
  }
  for (const message of validateAnimations(page.data)) warnings.push({ level: "error", code: "animation", page: page.path, element: null, message });
}

export function validateProject(input) {
  const warnings = [];
  let project;
  try { project = loadProject(input); } catch (error) { return { valid: false, errors: [{ level: "error", code: "parse", message: error.message }], warnings, project: null }; }
  if (project.manifest.version !== "v2") warnings.push({ level: "error", code: "version", message: "manifest.version 必须为 v2" });
  const size = project.size;
  if (!Array.isArray(size) || size.length !== 2 || size.some((n) => !Number.isFinite(Number(n)) || Number(n) <= 0)) warnings.push({ level: "error", code: "size", message: "size 必须是两个正数" });
  warnImageResources(manifestImageResourceRefs(project.manifest), warnings, project.root);
  for (const page of project.pages) warnPage(page, warnings, project.size, project.root);
  return { valid: !warnings.some((item) => item.level === "error"), errors: warnings.filter((item) => item.level === "error"), warnings: warnings.filter((item) => item.level !== "error"), project };
}

function esc(value) { return escapeXml(value); }
function px(value) { return Math.round(Number(value || 0) * EMU_PER_PX); }
function textSize(value) { return Math.max(100, Math.round(Number(value || 1) * 75)); }
function xmlHeader(value) { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`; }
function relsXml(rels) { return xmlHeader(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${esc(rel.target)}"${rel.targetMode ? ` TargetMode="${rel.targetMode}"` : ""}/>`).join("")}</Relationships>`); }
function colorParts(value, theme = {}) {
  let raw = value;
  const seen = new Set();
  while (typeof raw === "string" && raw.startsWith("$") && !seen.has(raw)) { seen.add(raw); raw = theme?.colors?.[raw.slice(1)] ?? raw; }
  if (typeof raw === "string" && /^#[0-9a-f]{8}$/i.test(raw)) return { hex: raw.slice(1, 7).toUpperCase(), alpha: Number.parseInt(raw.slice(7, 9), 16) };
  if (typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw)) return { hex: raw.slice(1).toUpperCase(), alpha: null };
  const rgba = String(raw ?? "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (rgba) return { hex: rgba.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase(), alpha: rgba[4] == null ? null : Math.round(Math.max(0, Math.min(1, Number(rgba[4]))) * 255) };
  return { hex: "000000", alpha: null };
}

function colorHex(value, theme) { return colorParts(value ?? "#000000", theme).hex; }
function alphaValue(value, theme) { return colorParts(value, theme).alpha; }

function fillXml(fill, theme, opacity = 1, imageRelId = null) {
  const alphaXml = (alpha, effectiveOpacity = opacity) => alpha == null && Number(effectiveOpacity) >= 1 ? "" : `<a:alpha val="${Math.round((alpha == null ? 1 : alpha / 255) * Math.max(0, Math.min(1, Number(effectiveOpacity))) * 100000)}"/>`;
  if (fill == null || fill?.type === "none") return "<a:noFill/>";
  if (typeof fill === "string") {
    const alpha = alphaValue(fill, theme);
    return `<a:solidFill><a:srgbClr val="${colorHex(fill, theme)}">${alphaXml(alpha)}</a:srgbClr></a:solidFill>`;
  }
  if (fill.type === "image") {
    const relation = typeof imageRelId === "function" ? imageRelId(fill) : imageRelId;
    if (!relation) return "<a:noFill/>";
    const crop = normalizedImageCrop(fill.crop);
    const imageOpacity = Math.max(0, Math.min(1, Number(opacity) * Number(fill.opacity ?? 1)));
    const srcRect = `<a:srcRect l="${Math.round(crop.left * 100000)}" t="${Math.round(crop.top * 100000)}" r="${Math.round(crop.right * 100000)}" b="${Math.round(crop.bottom * 100000)}"/>`;
    const alpha = imageOpacity < 1 ? `<a:alphaModFix amt="${Math.round(imageOpacity * 100000)}"/>` : "";
    return `<a:blipFill><a:blip r:embed="${esc(relation)}">${alpha}</a:blip>${srcRect}<a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
  }
  if (fill.type === "gradient" && Array.isArray(fill.stops) && fill.stops.length) {
    const stops = fill.stops.map((stop) => {
      const color = stop.color ?? "#000000";
      const alpha = alphaValue(color, theme);
      return `<a:gs pos="${Math.round(Math.max(0, Math.min(1, Number(stop.position) || 0)) * 100000)}"><a:srgbClr val="${colorHex(color, theme)}">${alphaXml(alpha)}</a:srgbClr></a:gs>`;
    }).join("");
    if (fill.gradientType === "radial") return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:path path="circle"/></a:gradFill>`;
    const angle = Math.round((Number(fill.angle) || 0) * 60000);
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${angle}" scaled="1"/></a:gradFill>`;
  }
  const color = fill.color ?? "#000000";
  const alpha = alphaValue(color, theme);
  return `<a:solidFill><a:srgbClr val="${colorHex(color, theme)}">${alphaXml(alpha)}</a:srgbClr></a:solidFill>`;
}

function customGeometryXml(element) {
  if (!element.path) return "";
  const viewBox = element.viewBox ?? [100, 100];
  const tokens = String(element.path).match(/[a-zA-Z]|-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? [];
  let cursor = 0; let command = ""; let x = 0; let y = 0; let startX = 0; let startY = 0; let lastControl = null; const commands = [];
  const number = () => Number(tokens[cursor++]); const point = (pxValue, pyValue) => `<a:pt x="${Math.round(pxValue)}" y="${Math.round(pyValue)}"/>`;
  const isCommand = () => /^[A-Za-z]$/.test(tokens[cursor] ?? "");
  const arcCubics = (x1, y1, rxValue, ryValue, rotation, largeArc, sweep, x2, y2) => {
    let rx = Math.abs(rxValue); let ry = Math.abs(ryValue); if (!rx || !ry || x1 === x2 && y1 === y2) return [];
    const phi = rotation * Math.PI / 180; const cos = Math.cos(phi); const sin = Math.sin(phi); const dx = (x1 - x2) / 2; const dy = (y1 - y2) / 2; const xp = cos * dx + sin * dy; const yp = -sin * dx + cos * dy; const scale = xp * xp / (rx * rx) + yp * yp / (ry * ry); if (scale > 1) { const factor = Math.sqrt(scale); rx *= factor; ry *= factor; }
    const sign = largeArc === sweep ? -1 : 1; const denominator = rx * rx * yp * yp + ry * ry * xp * xp; const coefficient = denominator ? sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - denominator) / denominator)) : 0; const cxp = coefficient * rx * yp / ry; const cyp = -coefficient * ry * xp / rx; const cx = cos * cxp - sin * cyp + (x1 + x2) / 2; const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angle = (ux, uy, vx, vy) => { const dot = ux * vx + uy * vy; const length = Math.hypot(ux, uy) * Math.hypot(vx, vy); const value = Math.acos(Math.max(-1, Math.min(1, dot / Math.max(1e-9, length)))); return ux * vy - uy * vx < 0 ? -value : value; };
    const ux = (xp - cxp) / rx; const uy = (yp - cyp) / ry; const vx = (-xp - cxp) / rx; const vy = (-yp - cyp) / ry; let start = angle(1, 0, ux, uy); let delta = angle(ux, uy, vx, vy); if (!sweep && delta > 0) delta -= Math.PI * 2; if (sweep && delta < 0) delta += Math.PI * 2;
    const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2)); const step = delta / segments; const result = [];
    const transformPoint = (uxValue, uyValue) => [cx + rx * (cos * uxValue - sin * uyValue), cy + ry * (sin * uxValue + cos * uyValue)];
    for (let index = 0; index < segments; index += 1) { const a = start + index * step; const b = a + step; const alpha = 4 / 3 * Math.tan((b - a) / 4); const p1 = transformPoint(Math.cos(a) - alpha * Math.sin(a), Math.sin(a) + alpha * Math.cos(a)); const p2 = transformPoint(Math.cos(b) + alpha * Math.sin(b), Math.sin(b) - alpha * Math.cos(b)); const p = transformPoint(Math.cos(b), Math.sin(b)); result.push([p1, p2, p]); }
    return result;
  };
  while (cursor < tokens.length) {
    if (isCommand()) command = tokens[cursor++];
    const relative = command === command.toLowerCase(); const kind = command.toUpperCase();
    if (kind === "Z") { commands.push("<a:close/>"); x = startX; y = startY; command = ""; lastControl = null; continue; }
    if (kind === "M" || kind === "L") { let nx = number(); let ny = number(); if (relative) { nx += x; ny += y; } x = nx; y = ny; const tag = kind === "M" ? "moveTo" : "lnTo"; commands.push(`<a:${tag}>${point(x, y)}</a:${tag}>`); if (kind === "M") { startX = x; startY = y; command = relative ? "l" : "L"; } lastControl = null; }
    else if (kind === "H") { let nx = number(); if (relative) nx += x; x = nx; commands.push(`<a:lnTo>${point(x, y)}</a:lnTo>`); lastControl = null; }
    else if (kind === "V") { let ny = number(); if (relative) ny += y; y = ny; commands.push(`<a:lnTo>${point(x, y)}</a:lnTo>`); lastControl = null; }
    else if (kind === "C") { let x1 = number(); let y1 = number(); let x2 = number(); let y2 = number(); let nx = number(); let ny = number(); if (relative) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; } commands.push(`<a:cubicBezTo>${point(x1, y1)}${point(x2, y2)}${point(nx, ny)}</a:cubicBezTo>`); x = nx; y = ny; lastControl = [x2, y2, "C"]; }
    else if (kind === "S") { const x1 = lastControl?.[2] === "C" ? x * 2 - lastControl[0] : x; const y1 = lastControl?.[2] === "C" ? y * 2 - lastControl[1] : y; let x2 = number(); let y2 = number(); let nx = number(); let ny = number(); if (relative) { x2 += x; y2 += y; nx += x; ny += y; } commands.push(`<a:cubicBezTo>${point(x1, y1)}${point(x2, y2)}${point(nx, ny)}</a:cubicBezTo>`); x = nx; y = ny; lastControl = [x2, y2, "C"]; }
    else if (kind === "Q" || kind === "T") { let x1; let y1; if (kind === "T") { x1 = lastControl?.[2] === "Q" ? x * 2 - lastControl[0] : x; y1 = lastControl?.[2] === "Q" ? y * 2 - lastControl[1] : y; } else { x1 = number(); y1 = number(); if (relative) { x1 += x; y1 += y; } } let nx = number(); let ny = number(); if (relative) { nx += x; ny += y; } commands.push(`<a:quadBezTo>${point(x1, y1)}${point(nx, ny)}</a:quadBezTo>`); x = nx; y = ny; lastControl = [x1, y1, "Q"]; }
    else if (kind === "A") { const rx = number(); const ry = number(); const rotation = number(); const large = Boolean(number()); const sweep = Boolean(number()); let nx = number(); let ny = number(); if (relative) { nx += x; ny += y; } for (const [control1, control2, end] of arcCubics(x, y, rx, ry, rotation, large, sweep, nx, ny)) commands.push(`<a:cubicBezTo>${point(...control1)}${point(...control2)}${point(...end)}</a:cubicBezTo>`); x = nx; y = ny; lastControl = null; }
    else throw new Error(`custom shape path 包含不支持的命令：${command}`);
  }
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${Math.round(Number(viewBox[0]) || 100)}" h="${Math.round(Number(viewBox[1]) || 100)}">${commands.join("")}</a:path></a:pathLst></a:custGeom>`;
}

function effectXml(effect) {
  if (!effect) return "";
  const color = colorHex(effect.color ?? "#000000", {});
  const blur = Math.max(0, Math.round(Number(effect.blur ?? 4) * 12700));
  const distance = Math.max(0, Math.round(Number(effect.distance ?? effect.offset?.[1] ?? 2) * 12700));
  const direction = Math.round(Number(effect.angle ?? 45) * 60000);
  return `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${distance}" dir="${direction}"><a:srgbClr val="${color}"/></a:outerShdw></a:effectLst>`;
}
function shapeXml(id, element, theme, imageRelId = null) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const name = String(element.shapeName ?? "rect");
  const preset = ({ circle: "ellipse" }[name] ?? (PRESET_SHAPE_NAMES.includes(name) ? name : "rect"));
  const values = Array.isArray(element.adjustments) ? element.adjustments : (SHAPE_ADJUSTMENTS[name] ?? []);
  const adjustments = adjustmentGuidesXml(name, values);
  const fill = fillXml(element.fill, theme, element.opacity ?? 1, imageRelId);
  const border = element.line ?? element.border;
  const line = border?.color ? `<a:ln w="${px(border.width ?? 1)}"><a:solidFill>${fillXml(border.color, theme).replace(/^<a:solidFill>|<\/a:solidFill>$/g, "")}</a:solidFill>${border.style === "dash" ? '<a:prstDash val="dash"/>' : ""}</a:ln>` : `<a:ln><a:noFill/></a:ln>`;
  const transform = `${element.rotation ?? element.rotate ? ` rot="${Math.round(Number(element.rotation ?? element.rotate) * 60000)}"` : ""}${element.flip?.[0] || element.flipH ? ' flipH="1"' : ""}${element.flip?.[1] || element.flipV ? ' flipV="1"' : ""}`;
  const geometry = name === "custom" ? customGeometryXml(element) : `<a:prstGeom prst="${preset}"><a:avLst>${adjustments}</a:avLst></a:prstGeom>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Shape ${id}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr${element.opacity != null ? `><a:xfrm${transform}` : `><a:xfrm${transform}`}><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm>${geometry}${fill}${line}${effectXml(element.shadow)}</p:spPr></p:sp>`;
}

function lineXml(id, element, theme) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0]; const viewBox = element.viewBox ?? [1, 1];
  const points = String(element.points ?? "0,0 1,1").trim().split(/\s+/).map((item) => item.split(",").map(Number)).filter((item) => item.length === 2 && item.every(Number.isFinite));
  const path = points.length === 3 ? `M ${points[0]} Q ${points[1]} ${points[2]}` : points.length >= 4 ? `M ${points[0]} C ${points[1]} ${points[2]} ${points[3]} ${points.slice(4).map((pointValue) => `L ${pointValue}`).join(" ")}` : `M ${points[0] ?? [0, 0]} ${points.slice(1).map((pointValue) => `L ${pointValue}`).join(" ")}`;
  const geometry = customGeometryXml({ path, viewBox }); const border = element.border ?? { color: "#000000", width: 1 };
  const arrows = element.arrow ?? []; const arrowType = (value) => ({ arrow: "triangle", stealth: "stealth", diamond: "diamond", oval: "oval" }[value] ?? "none");
  const line = `<a:ln w="${px(border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(border.color ?? "#000000", theme)}"/></a:solidFill><a:prstDash val="${border.style === "dash" ? "dash" : border.style === "dot" ? "dot" : "solid"}"/>${arrows[0] ? `<a:headEnd type="${arrowType(arrows[0])}"/>` : ""}${arrows[1] ? `<a:tailEnd type="${arrowType(arrows[1])}"/>` : ""}</a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Line ${id}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm>${geometry}<a:noFill/>${line}${effectXml(element.shadow)}</p:spPr></p:sp>`;
}

function fontFaceXml(value, fallback = "Arial") {
  if (value && typeof value === "object") {
    const latin = value.latin ?? value.name ?? fallback; const eastAsia = value.eastAsia ?? value.ea ?? latin; const complex = value.complexScript ?? value.cs ?? latin;
    return `<a:latin typeface="${esc(latin)}"/><a:ea typeface="${esc(eastAsia)}"/><a:cs typeface="${esc(complex)}"/>`;
  }
  const names = String(value ?? fallback).split(",").map((name) => name.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean); const latin = names[0] ?? fallback; const eastAsia = names[1] ?? latin;
  return `<a:latin typeface="${esc(latin)}"/><a:ea typeface="${esc(eastAsia)}"/><a:cs typeface="${esc(latin)}"/>`;
}

function richTextParagraphsXml(value, content, theme, hyperlinkRel, opacity = 1) {
  return parseRichText(value, content).map((runs) => {
    const paragraphStyle = { ...content, ...(runs.style ?? {}) };
    const body = runs.map((run) => {
      if (run.break) return `<a:br><a:rPr lang="zh-CN"/></a:br>`;
      if (run.formula) return `<a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><m:oMath>${formulaTokens(run.formula, { color: run.style?.color, fontSize: run.style?.fontSize }, theme)}</m:oMath></a14:m>`;
      const style = run.style ?? content; const fontSize = textSize(style.fontSize ?? content.fontSize ?? 16); const family = style.fontFamily ?? content.fontFamily ?? "Arial";
      const props = `${style.bold ? " b=\"1\"" : ""}${style.italic ? " i=\"1\"" : ""}${style.underline ? " u=\"sng\"" : ""}${style.strike ? " strike=\"sngStrike\"" : ""}${style.baseline ? ` baseline="${style.baseline}"` : ""}${style.letterSpacing ? ` spc="${Math.round(Number(style.letterSpacing) * 75)}"` : ""}`;
      const color = style.color ?? content.color; const hyperlink = style.href && hyperlinkRel ? `<a:hlinkClick r:id="${hyperlinkRel(style.href)}"/>` : ""; const highlight = style.backgroundColor ? `<a:highlight><a:srgbClr val="${colorHex(style.backgroundColor, theme)}"/></a:highlight>` : ""; const preserve = /^\s|\s$/.test(run.text ?? "") ? ' xml:space="preserve"' : ""; const explicitColor = run.style?.color != null && run.style.color !== content.color; const textFill = style.gradient && !explicitColor ? fillXml(style.gradient, theme, opacity) : fillXml(color ?? "#000000", theme, opacity);
      return `<a:r><a:rPr lang="zh-CN" sz="${fontSize}"${props}>${textFill}${effectXml(style.shadow)}${highlight}${fontFaceXml(family)}${hyperlink}</a:rPr><a:t${preserve}>${esc(run.text || " ")}</a:t></a:r>`;
    }).join("");
    const horizontal = paragraphStyle.textAlign ?? paragraphStyle.align?.[0]; const alignment = horizontal === "center" ? "ctr" : horizontal === "right" ? "r" : horizontal === "justify" ? "just" : horizontal === "distributed" ? "dist" : "l";
    const lineSpacing = paragraphStyle.lineHeightPx ? `<a:lnSpc><a:spcPts val="${Math.round(Number(paragraphStyle.lineHeightPx) * 75)}"/></a:lnSpc>` : paragraphStyle.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(Number(paragraphStyle.lineHeight) * 100000)}"/></a:lnSpc>` : ""; const spacingBefore = paragraphStyle.marginTop ? `<a:spcBef><a:spcPts val="${Math.round(Number(paragraphStyle.marginTop) * 75)}"/></a:spcBef>` : "";
    const orderedType = { "lower-alpha": "alphaLcPeriod", "upper-alpha": "alphaUcPeriod", "lower-roman": "romanLcPeriod", "upper-roman": "romanUcPeriod", decimal: "arabicPeriod" }[runs.bullet?.style] ?? "arabicPeriod"; const unorderedChar = { circle: "○", square: "■", none: "" }[runs.bullet?.style] ?? "•"; const bullet = runs.bullet?.type === "ordered" ? `<a:buAutoNum type="${orderedType}" startAt="${runs.bullet.startAt}"/>` : runs.bullet && unorderedChar ? `<a:buChar char="${unorderedChar}"/>` : "<a:buNone/>"; const listMargin = runs.bullet ? Number(paragraphStyle.marginLeft ?? 18) : Number(paragraphStyle.marginLeft ?? 0); const indent = runs.bullet ? ` indent="${-px(10)}"` : "";
    return `<a:p><a:pPr algn="${alignment}"${listMargin ? ` marL="${px(listMargin)}"` : ""}${indent}${paragraphStyle.marginRight ? ` marR="${px(paragraphStyle.marginRight)}"` : ""}>${lineSpacing}${spacingBefore}${bullet}</a:pPr>${body}<a:endParaRPr lang="zh-CN" sz="${textSize(paragraphStyle.fontSize ?? 16)}"/></a:p>`;
  }).join("");
}
function textXml(id, element, theme, hyperlinkRel) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0]; const content = themeStyle(null, element.content ?? {}, theme); const paragraphs = richTextParagraphsXml(content.text ?? element.text ?? "", content, theme, hyperlinkRel, element.opacity ?? 1); const transform = `${element.rotation ?? element.rotate ? ` rot="${Math.round(Number(element.rotation ?? element.rotate) * 60000)}"` : ""}${element.flip?.[0] || element.flipH ? ' flipH="1"' : ""}${element.flip?.[1] || element.flipV ? ' flipV="1"' : ""}`; const vertical = { top: "t", middle: "ctr", bottom: "b" }[content.align?.[1]] ?? "t"; const wrap = content.wrap === false ? "none" : "square"; const inset = content.padding; const insets = Array.isArray(inset) ? inset.length === 2 ? [inset[1], inset[0], inset[1], inset[0]] : [inset[3] ?? 0, inset[0] ?? 0, inset[1] ?? 0, inset[2] ?? 0] : [0, 0, 0, 0]; const textDirection = content.textDirection === "vertical" ? ' vert="vert"' : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Text ${id}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${transform}><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody xmlns:m="${XML_NS.m}"><a:bodyPr wrap="${wrap}" anchor="${vertical}"${textDirection} lIns="${px(insets[0])}" tIns="${px(insets[1])}" rIns="${px(insets[2])}" bIns="${px(insets[3])}"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}
function imageXml(id, relId, element, theme = {}) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const crop = element.crop ?? {};
  const srcRect = Object.keys(crop).length ? `<a:srcRect l="${Math.round(Number(crop.left ?? 0) * 100000)}" t="${Math.round(Number(crop.top ?? 0) * 100000)}" r="${Math.round(Number(crop.right ?? 0) * 100000)}" b="${Math.round(Number(crop.bottom ?? 0) * 100000)}"/>` : `<a:srcRect/>`;
  const transform = `${element.rotation ?? element.rotate ? ` rot="${Math.round(Number(element.rotation ?? element.rotate) * 60000)}"` : ""}${element.flip?.[0] || element.flipH ? ' flipH="1"' : ""}${element.flip?.[1] || element.flipV ? ' flipV="1"' : ""}`;
  const cropShape = element.cropShape; const shapeName = cropShape?.shapeName === "circle" ? "ellipse" : cropShape?.shapeName;
  const geometry = cropShape?.shapeName === "custom" ? customGeometryXml(cropShape) : `<a:prstGeom prst="${shapeName && PRESET_SHAPE_NAMES.includes(shapeName) ? shapeName : "rect"}"><a:avLst>${adjustmentGuidesXml(shapeName, cropShape?.adjustments ?? SHAPE_ADJUSTMENTS[shapeName] ?? [])}</a:avLst></a:prstGeom>`;
  const border = element.border ? `<a:ln w="${px(element.border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(element.border.color, theme)}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Image ${id}`)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}">${element.opacity != null ? `<a:alphaModFix amt="${Math.round(Math.max(0, Math.min(1, Number(element.opacity))) * 100000)}"/>` : ""}</a:blip>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm${transform}><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm>${geometry}${border}${effectXml(element.shadow)}</p:spPr></p:pic>`;
}

function notesSlideXml(notes) {
  const paragraphs = String(notes ?? "").split(/\r?\n/).map((line) => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t${/^\s|\s$/.test(line) ? ' xml:space="preserve"' : ""}>${esc(line)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>`).join("");
  return xmlHeader(`<p:notes xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"><p:cSld name=""><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
}

function notesMasterXml() {
  return xmlHeader(`<p:notesMaster xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"><p:cSld name=""><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/></p:notesMaster>`);
}

function normalizeTableGrid(element) {
  const rows = Array.isArray(element.rows) ? element.rows : [];
  const grid = [];
  let columnCount = Array.isArray(element.columnWidths) ? element.columnWidths.length : 0;
  for (let row = 0; row < rows.length; row += 1) {
    grid[row] ??= [];
    let column = 0;
    for (const raw of Array.isArray(rows[row]) ? rows[row] : []) {
      while (grid[row][column]) column += 1;
      const cell = raw && typeof raw === "object" ? raw : { text: raw == null ? "" : String(raw) };
      const rowSpan = Math.max(1, Math.round(Number(cell.rowSpan) || 1));
      const colSpan = Math.max(1, Math.round(Number(cell.colSpan) || 1));
      for (let r = row; r < row + rowSpan; r += 1) {
        grid[r] ??= [];
        for (let c = column; c < column + colSpan; c += 1) {
          if (grid[r][c]) throw new Error(`表格合并区域重叠：row=${row}, col=${column}`);
          grid[r][c] = { cell, originRow: row, originCol: column, rowSpan, colSpan, hMerge: c > column, vMerge: r > row };
        }
      }
      column += colSpan;
      columnCount = Math.max(columnCount, column);
    }
  }
  const rowCount = Math.max(grid.length, element.rowHeights?.length ?? 0, 1);
  columnCount = Math.max(columnCount, 1);
  for (let row = 0; row < rowCount; row += 1) for (let column = 0; column < columnCount; column += 1) grid[row][column] ??= { cell: { text: "" }, originRow: row, originCol: column, rowSpan: 1, colSpan: 1, hMerge: false, vMerge: false };
  return { grid, rowCount, columnCount };
}

function normalizedRatios(values, count) {
  if (!Array.isArray(values) || values.length !== count || values.some((value) => !(Number(value) > 0))) return Array.from({ length: count }, () => 1 / count);
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return values.map((value) => Number(value) / total);
}

function tableStyleConfig(element, theme) {
  if (typeof element.style === "string" && element.style.startsWith("$")) return theme?.tableStyles?.[element.style.slice(1)] ?? {};
  return element.style && typeof element.style === "object" ? element.style : {};
}

function resolveTableCellStyle(element, cell, row, column, rowCount, columnCount, theme) {
  const table = tableStyleConfig(element, theme);
  const base = { color: "#000000", fontFamily: "MiSans", bold: false, italic: false, fill: element.fill, border: { style: "solid", width: 1, color: "#000000" }, align: ["center", "middle"], ...(table.cellStyle ?? {}) };
  const bodyIndex = row - (table.firstRowStyle ? 1 : 0);
  const body = row > 0 && row < rowCount - 1 && table.bodyStyles?.length ? table.bodyStyles[Math.max(0, bodyIndex) % table.bodyStyles.length] : {};
  const rowStyle = row === 0 ? table.firstRowStyle : row === rowCount - 1 ? table.lastRowStyle : {};
  const columnStyle = column === 0 ? table.firstColumnStyle : column === columnCount - 1 ? table.lastColumnStyle : {};
  const positions = table.rowOverColumn === false ? { ...rowStyle, ...columnStyle } : { ...columnStyle, ...rowStyle };
  const textStyle = typeof cell.textStyle === "string" && cell.textStyle.startsWith("$") ? theme?.textStyles?.[cell.textStyle.slice(1)] ?? {} : {};
  return { ...base, ...body, ...positions, ...textStyle, ...cell };
}

function borderSides(border) {
  if (border === null) return [null, null, null, null];
  if (Array.isArray(border)) return border.length === 2 ? [border[0], border[1], border[0], border[1]] : [border[0], border[1], border[2], border[3]];
  const value = border ?? { style: "solid", width: 1, color: "#000000" };
  return [value, value, value, value];
}

function tableCellPropertiesXml(style, theme, imageRelId = null) {
  const [top, right, bottom, left] = borderSides(style.border);
  const line = (name, border) => border ? `<a:${name} w="${px(border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(border.color ?? "#000000", theme)}"/></a:solidFill><a:prstDash val="${border.style === "dash" ? "dash" : border.style === "dot" ? "dot" : "solid"}"/></a:${name}>` : `<a:${name}><a:noFill/></a:${name}>`;
  const anchor = style.align?.[1] === "top" ? "t" : style.align?.[1] === "bottom" ? "b" : "ctr";
  return `<a:tcPr anchor="${anchor}">${fillXml(style.fill, theme, 1, imageRelId)}${line("lnL", left)}${line("lnR", right)}${line("lnT", top)}${line("lnB", bottom)}</a:tcPr>`;
}
function tableXml(id, element, theme, hyperlinkRel, imageRelId = null) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  const model = normalizeTableGrid(element);
  const columnWidths = normalizedRatios(element.columnWidths, model.columnCount);
  const rowHeights = normalizedRatios(element.rowHeights, model.rowCount);
  const grid = columnWidths.map((ratio) => `<a:gridCol w="${px(w * ratio)}"/>`).join("");
  const trs = model.grid.map((row, rowIndex) => `<a:tr h="${px(h * rowHeights[rowIndex])}">${row.map((entry, columnIndex) => {
    const merge = `${entry.hMerge ? ' hMerge="1"' : ""}${entry.vMerge ? ' vMerge="1"' : ""}${!entry.hMerge && !entry.vMerge && entry.colSpan > 1 ? ` gridSpan="${entry.colSpan}"` : ""}${!entry.hMerge && !entry.vMerge && entry.rowSpan > 1 ? ` rowSpan="${entry.rowSpan}"` : ""}`;
    const style = resolveTableCellStyle(element, entry.cell, entry.originRow, entry.originCol, model.rowCount, model.columnCount, theme);
    const text = entry.hMerge || entry.vMerge ? "" : entry.cell.text ?? "";
    const paragraphs = richTextParagraphsXml(text, style, theme, hyperlinkRel);
    return `<a:tc${merge}><a:txBody xmlns:m="${XML_NS.m}"><a:bodyPr/><a:lstStyle/>${paragraphs}</a:txBody>${tableCellPropertiesXml(style, theme, imageRelId)}</a:tc>`;
  }).join("")}</a:tr>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Table ${id}`)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function chartXml(id, relId, element) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0];
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Chart ${id}`)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="${XML_NS.c}" xmlns:r="${XML_NS.r}" r:id="${relId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

function editableChartGroupXml(id, firstChildId, element, theme) {
  const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0]; const model = chartModel(element); const series = model.series[0] ?? {}; const children = []; let childId = firstChildId;
  const pushShape = (bounds, fill, border, name) => children.push(shapeXml(childId++, { elementId: name, elementType: "shape", shapeName: "rect", bounds, fill, border }, theme));
  const pushText = (bounds, text, style = {}, name) => children.push(textXml(childId++, { elementId: name, elementType: "text", bounds, content: { text, fontSize: 10, color: "#111827", align: ["center", "middle"], ...style } }, theme));
  const pushPath = (path, fill, border, name) => children.push(shapeXml(childId++, { elementId: name, elementType: "shape", shapeName: "custom", bounds: [0, 0, w, h], viewBox: [w, h], path, fill, border }, theme));
  const title = typeof model.chart.title === "string" ? model.chart.title : model.chart.title?.text; const top = title ? 30 : 6;
  pushShape([0, 0, w, h], model.chart.fill ?? "#FFFFFF00", model.chart.border, `${element.elementId ?? "chart"}-frame`);
  if (title) pushText([8, 3, w - 16, 24], title, { fontSize: model.chart.title?.fontSize ?? 15, color: model.chart.title?.color ?? "#111827", fontFamily: model.chart.title?.fontFamily ?? model.chart.fontFamily, bold: true }, `${element.elementId ?? "chart"}-title`);
  if (series.type === "heatmap") {
    const xs = [...new Set(model.objects.map((row) => String(row[series.encode.x])))]; const ys = [...new Set(model.objects.map((row) => String(row[series.encode.y])))]; const values = model.objects.map((row) => Number(row[series.encode.value])).filter(Number.isFinite); const magnitude = Math.max(1, ...values.map(Math.abs)); const diverging = series.colorScale?.type === "diverging"; const min = series.colorScale?.domain?.[0] ?? (diverging ? -magnitude : Math.min(0, ...values)); const max = series.colorScale?.domain?.[1] ?? (diverging ? magnitude : Math.max(1, ...values)); const colors = series.colorScheme ?? (diverging ? ["#2563EB", "#F8FAFC", "#DC2626"] : ["#EFF6FF", "#1783FF"]); const colorbar = series.colorbar !== false && series.colorbar?.show !== false; const left = 44; const bottom = 24; const right = colorbar ? 52 : 8; const plotW = Math.max(1, w - left - right); const plotH = Math.max(1, h - top - bottom); const labels = effectiveDataLabels(model.chart, series);
    model.objects.forEach((row, rowIndex) => { const xi = xs.indexOf(String(row[series.encode.x])); const yi = ys.indexOf(String(row[series.encode.y])); const value = Number(row[series.encode.value]); if (!Number.isFinite(value)) return; const ratio = (value - min) / Math.max(1e-9, max - min); const bounds = [left + xi * plotW / Math.max(1, xs.length), top + yi * plotH / Math.max(1, ys.length), plotW / Math.max(1, xs.length), plotH / Math.max(1, ys.length)]; pushShape(bounds, interpolateChartColor(colors, ratio, theme), { color: "#FFFFFF", width: .5 }, `${element.elementId ?? "heatmap"}-cell-${rowIndex + 1}`); if (labels?.show) pushText(bounds, String(value), { fontSize: labels.fontSize ?? 9, color: labels.color ?? "#111827", fontFamily: labels.fontFamily ?? model.chart.fontFamily }, `${element.elementId ?? "heatmap"}-label-${rowIndex + 1}`); });
    xs.forEach((label, index) => pushText([left + index * plotW / Math.max(1, xs.length), top + plotH, plotW / Math.max(1, xs.length), bottom], label, { fontSize: 9 }, `${element.elementId ?? "heatmap"}-x-${index + 1}`));
    ys.forEach((label, index) => pushText([0, top + index * plotH / Math.max(1, ys.length), left - 4, plotH / Math.max(1, ys.length)], label, { fontSize: 9, align: ["right", "middle"] }, `${element.elementId ?? "heatmap"}-y-${index + 1}`));
    if (colorbar) { for (let index = 0; index < 16; index += 1) pushShape([w - 29, top + index * plotH / 16, 9, plotH / 16 + .5], interpolateChartColor(colors, 1 - index / 15, theme), null, `${element.elementId ?? "heatmap"}-scale-${index + 1}`); pushText([w - 19, top - 5, 18, 14], String(max), { fontSize: 8, align: ["left", "middle"] }, `${element.elementId ?? "heatmap"}-max`); pushText([w - 19, top + plotH - 8, 18, 14], String(min), { fontSize: 8, align: ["left", "middle"] }, `${element.elementId ?? "heatmap"}-min`); }
  } else if (series.type === "treemap") {
    const hierarchy = hierarchyModel(model, series); const levels = Math.min(hierarchy.maxDepth, Number(series.levels) || hierarchy.maxDepth); const labels = effectiveDataLabels(model.chart, series); const left = 4; const topInset = top + 2; const plotW = Math.max(1, w - left * 2); const plotH = Math.max(1, h - topInset - 4); let nodeIndex = 0;
    layoutTreemap(hierarchy, [left, topInset, plotW, plotH], levels, (node, box) => {
      const border = series.border ? series.border : undefined; pushShape(box, hierarchyFill(series, node, theme), border, `${element.elementId ?? "treemap"}-node-${++nodeIndex}`);
      if (labels?.show && box[2] > 24 && box[3] > 14) pushText([box[0] + 4, box[1] + 2, Math.max(1, box[2] - 8), Math.min(20, box[3] - 4)], String(labels.content === "value" ? node.value : node.name), { fontSize: labels.fontSize ?? 10, color: labels.color ?? "#ffffff", fontFamily: labels.fontFamily ?? model.chart.fontFamily, align: ["left", "top"] }, `${element.elementId ?? "treemap"}-label-${nodeIndex}`);
    });
  } else if (series.type === "sunburst") {
    const hierarchy = hierarchyModel(model, series); const levels = Math.min(hierarchy.maxDepth, Number(series.levels) || hierarchy.maxDepth); const labels = effectiveDataLabels(model.chart, series); const center = [w / 2, top + (h - top) / 2]; const radius = Math.min(w, h - top) * .45; let nodeIndex = 0;
    layoutSunburst(hierarchy, center, radius, levels, (node, inner, outer, start, end) => {
      pushPath(svgRingPath(center[0], center[1], inner, outer, start, end), hierarchyFill(series, node, theme), series.border, `${element.elementId ?? "sunburst"}-node-${++nodeIndex}`);
      if (labels?.show && end - start > .18) { const angle = (start + end) / 2; const r = (inner + outer) / 2; const tx = center[0] + Math.sin(angle) * r; const ty = center[1] - Math.cos(angle) * r; const labelWidth = Math.min(110, w); const labelHeight = Math.min(16, Math.max(1, h - top)); const labelX = Math.max(0, Math.min(w - labelWidth, tx - labelWidth / 2)); const labelY = Math.max(top, Math.min(h - labelHeight, ty - labelHeight / 2)); pushText([labelX, labelY, labelWidth, labelHeight], String(labels.content === "value" ? node.value : node.name), { fontSize: labels.fontSize ?? 9, color: labels.color ?? "#ffffff", fontFamily: labels.fontFamily ?? model.chart.fontFamily }, `${element.elementId ?? "sunburst"}-label-${nodeIndex}`); }
    });
  } else if (series.type === "sankey") {
    const sourceKey = series.encode.source; const targetKey = series.encode.target; const flowKey = series.encode.flow; const nodes = [...new Set(model.objects.flatMap((row) => [String(row[sourceKey]), String(row[targetKey])]))]; const outgoing = new Map(nodes.map((node) => [node, []])); const incoming = new Map(nodes.map((node) => [node, []]));
    model.objects.forEach((row) => { const source = String(row[sourceKey]); const target = String(row[targetKey]); outgoing.get(source)?.push(target); incoming.get(target)?.push(source); });
    const indegree = new Map(nodes.map((node) => [node, incoming.get(node).length])); const queue = nodes.filter((node) => indegree.get(node) === 0); const order = []; const depth = new Map(nodes.map((node) => [node, 0]));
    while (queue.length) { const node = queue.shift(); order.push(node); for (const target of outgoing.get(node) ?? []) { depth.set(target, Math.max(depth.get(target), depth.get(node) + 1)); indegree.set(target, indegree.get(target) - 1); if (indegree.get(target) === 0) queue.push(target); } }
    for (const node of nodes) if (!order.includes(node)) order.push(node); let maxDepth = Math.max(1, ...depth.values());
    if (series.nodeAlign === "justify" || series.nodeAlign == null) for (const node of nodes) if (!(outgoing.get(node)?.length)) depth.set(node, maxDepth);
    if (series.nodeAlign === "right") { const toSink = new Map(); const distance = (node) => { if (toSink.has(node)) return toSink.get(node); const targets = outgoing.get(node) ?? []; const value = targets.length ? 1 + Math.max(...targets.map(distance)) : 0; toSink.set(node, value); return value; }; nodes.forEach((node) => depth.set(node, maxDepth - distance(node))); }
    maxDepth = Math.max(1, ...depth.values()); const levels = new Map(); nodes.forEach((node) => { const level = depth.get(node); if (!levels.has(level)) levels.set(level, []); levels.get(level).push(node); }); const positions = new Map(); const left = 12; const right = 12; const plotH = Math.max(1, h - top - 8); const nodeW = Math.max(10, Math.min(20, w * .035)); const nodeH = Math.max(12, Math.min(24, plotH / Math.max(2, ...[...levels.values()].map((items) => items.length * 2))));
    for (const [level, names] of levels) names.forEach((name, index) => positions.set(name, [left + level * (w - left - right - nodeW) / maxDepth, top + (index + .5) * plotH / names.length - nodeH / 2]));
    const flows = model.objects.map((row) => Math.max(0, Number(row[flowKey]) || 0)); const maxFlow = Math.max(1, ...flows);
    model.objects.forEach((row, index) => { const start = positions.get(String(row[sourceKey])); const end = positions.get(String(row[targetKey])); if (!start || !end) return; const middle = (start[0] + nodeW + end[0]) / 2; const points = `${start[0] + nodeW},${start[1] + nodeH / 2} ${middle},${start[1] + nodeH / 2} ${middle},${end[1] + nodeH / 2} ${end[0]},${end[1] + nodeH / 2}`; children.push(lineXml(childId++, { elementId: `${element.elementId ?? "sankey"}-link-${index + 1}`, elementType: "line", bounds: [0, 0, w, h], viewBox: [w, h], points, curve: "smooth", border: { color: "#94A3B8", width: 1 + flows[index] / maxFlow * 11 } }, theme)); });
    const nodeFill = (name, index) => { const fill = series.fill; if (Array.isArray(fill)) return fill[index % fill.length]; if (fill && typeof fill === "object" && !fill.type && !fill.color && !fill.stops) return fill[name]; return fill ?? ["#1783FF", "#68B8A8", "#C9A86A", "#8C84C9"][index % 4]; };
    const labels = effectiveDataLabels(model.chart, series); order.forEach((name, index) => { const position = positions.get(name); if (!position) return; pushShape([position[0], position[1], nodeW, nodeH], nodeFill(name, index), series.border, `${element.elementId ?? "sankey"}-node-${index + 1}`); const incomingValue = model.objects.reduce((sum, row) => sum + (String(row[targetKey]) === name ? Math.max(0, Number(row[flowKey]) || 0) : 0), 0); const outgoingValue = model.objects.reduce((sum, row) => sum + (String(row[sourceKey]) === name ? Math.max(0, Number(row[flowKey]) || 0) : 0), 0); const value = Math.max(incomingValue, outgoingValue); const text = labels?.show && labels.content === "value" ? `${name} ${value}` : name; const onRight = position[0] > w / 2; pushText([onRight ? position[0] - 112 : position[0] + nodeW + 4, position[1] - 1, 108, nodeH + 2], text, { fontSize: labels?.fontSize ?? 9, color: labels?.color ?? "#111827", fontFamily: labels?.fontFamily ?? model.chart.fontFamily, align: [onRight ? "right" : "left", "middle"] }, `${element.elementId ?? "sankey"}-label-${index + 1}`); });
  }
  const transform = `<a:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/><a:chOff x="0" y="0"/><a:chExt cx="${px(w)}" cy="${px(h)}"/></a:xfrm>`;
  return { xml: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${esc(element.elementId ?? `Editable chart ${id}`)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${transform}</p:grpSpPr>${children.join("")}</p:grpSp>`, nextId: childId };
}

function excelColumn(index) {
  let value = index + 1; let result = "";
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

function chartReference(model, column) {
  const index = model.cols.indexOf(column); const letter = excelColumn(Math.max(0, index));
  return { index, formula: `Sheet1!$${letter}$2:$${letter}$${model.rows.length + 1}`, titleFormula: `Sheet1!$${letter}$1`, values: model.rows.map((row) => row?.[index] ?? null) };
}

function chartCache(reference, numeric) {
  const tag = numeric ? "numCache" : "strCache";
  const format = numeric ? "<c:formatCode>General</c:formatCode>" : "";
  const points = reference.values.map((value, index) => value == null || value === "" ? "" : `<c:pt idx="${index}"><c:v>${esc(numeric ? Number(value) : value)}</c:v></c:pt>`).join("");
  return `<c:${tag}>${format}<c:ptCount val="${reference.values.length}"/>${points}</c:${tag}>`;
}

function chartDataRef(tag, reference, numeric = false) {
  const ref = numeric ? "numRef" : "strRef";
  return `<c:${tag}><c:${ref}><c:f>${esc(reference.formula)}</c:f>${chartCache(reference, numeric)}</c:${ref}></c:${tag}>`;
}

function chartStyledColorXml(value, border, theme) {
  const dash = { dash: "dash", dot: "dot" }[border?.style] ?? "solid";
  const line = border ? `<a:ln w="${px(border.width ?? 1)}">${fillXml(border.color ?? "#000000", theme)}<a:prstDash val="${dash}"/></a:ln>` : "<a:ln><a:noFill/></a:ln>";
  return `<c:spPr>${fillXml(value ?? "#1783FF", theme)}${line}</c:spPr>`;
}

function chartSeriesStyleXml(item, color, theme) {
  const border = item.border; const dash = { dash: "dash", dot: "dot", solid: "solid" }[border?.style ?? item.lineStyle] ?? "solid";
  if (["line", "area", "radar"].includes(item.type)) {
    const lineColor = item.lineColor ?? color; const areaFill = item.type === "line" ? "<a:noFill/>" : fillXml(item.areaColor ?? `#${colorHex(lineColor, theme)}40`, theme);
    return `<c:spPr>${areaFill}<a:ln w="${px(item.width ?? border?.width ?? 2)}">${fillXml(lineColor, theme)}<a:prstDash val="${dash}"/></a:ln></c:spPr>`;
  }
  return `<c:spPr>${fillXml(color, theme)}${border ? `<a:ln w="${px(border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(border.color ?? "#000000", theme)}"/></a:solidFill><a:prstDash val="${dash}"/></a:ln>` : `<a:ln><a:noFill/></a:ln>`}</c:spPr>`;
}

function chartDataPointsXml(item, model, theme) {
  if (item.type === "waterfall") return model.objects.map((row, index) => { const total = item.encode?.isTotal && row[item.encode.isTotal] === true; const value = Number(row[item._waterfallSourceY ?? item.encode?.y]); const role = total ? item.totalBars : value >= 0 ? item.increaseBars : item.decreaseBars; return `<c:dPt><c:idx val="${index}"/>${chartSeriesStyleXml({ type: "bar", border: role?.border }, role?.fill ?? (total ? "#64748B" : value >= 0 ? "#16A34A" : "#DC2626"), theme)}</c:dPt>`; }).join("");
  if (!Array.isArray(item.fill)) return "";
  return model.rows.map((_, index) => `<c:dPt><c:idx val="${index}"/>${chartSeriesStyleXml(item, item.fill[index % item.fill.length], theme)}</c:dPt>`).join("");
}

function chartMarkerXml(marker, color, theme, defaultVisible = true) {
  if (marker === false || marker == null && !defaultVisible) return `<c:marker><c:symbol val="none"/></c:marker>`;
  const config = marker && typeof marker === "object" ? marker : {};
  const symbol = { circle: "circle", rect: "square", diamond: "diamond", triangle: "triangle" }[config.shape] ?? "circle";
  return `<c:marker><c:symbol val="${symbol}"/><c:size val="${Math.max(2, Math.min(72, Math.round(Number(config.size ?? 6))))}"/><c:spPr>${fillXml(config.fill ?? color, theme)}${config.border ? `<a:ln w="${px(config.border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(config.border.color, theme)}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`}</c:spPr></c:marker>`;
}

function chartTextPropertiesXml(style = {}, fallbackFont, theme = {}) {
  const family = typeof style.fontFamily === "string" ? style.fontFamily : style.fontFamily?.latin ?? (typeof fallbackFont === "string" ? fallbackFont : fallbackFont?.latin) ?? "Arial";
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr lang="zh-CN"${style.fontSize ? ` sz="${textSize(style.fontSize)}"` : ""}><a:solidFill><a:srgbClr val="${colorHex(style.color ?? "#000000", theme)}"/></a:solidFill>${fontFaceXml(style.fontFamily ?? fallbackFont ?? family)}</a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>`;
}

function chartLabelsXml(labels, theme = {}, fallbackFont) {
  if (!labels || labels.show === false) return "";
  const content = labels.content ?? "value";
  return `<c:dLbls>${labels.numberFormat ? `<c:numFmt formatCode="${esc(labels.numberFormat)}" sourceLinked="0"/>` : ""}${chartTextPropertiesXml(labels, fallbackFont, theme)}<c:showLegendKey val="0"/><c:showVal val="${content === "value" ? 1 : 0}"/><c:showCatName val="${content === "category" ? 1 : 0}"/><c:showSerName val="0"/><c:showPercent val="${content === "percentage" ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`;
}

function chartSeriesXml(model, item, index, theme) {
  const encode = item.encode ?? {}; const color = item.fill ?? item.lineColor ?? item.areaColor ?? ["#1783FF", "#68B8A8", "#C9A86A", "#8C84C9"][index % 4];
  const nameColumn = item._waterfallHelper ? null : encode.y ?? encode.value ?? encode.close ?? encode.flow; const name = item.name ?? nameColumn ?? `Series ${index + 1}`;
  const base = `<c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>${esc(nameColumn && model.cols.includes(nameColumn) ? chartReference(model, nameColumn).titleFormula : "")}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
  const labelsConfig = item.dataLabels === false ? null : item.dataLabels || model.chart.dataLabels ? { ...(model.chart.dataLabels ?? {}), ...(item.dataLabels ?? {}) } : null;
  const labels = chartLabelsXml(labelsConfig, theme, model.chart.fontFamily);
  if (["scatter", "bubble"].includes(item.type)) {
    const x = chartReference(model, encode.x); const y = chartReference(model, encode.y);
    const bubble = item.type === "bubble" ? chartDataRef("bubbleSize", chartReference(model, encode.size), true) : "";
    return `<c:ser>${base}${chartSeriesStyleXml(item, color, theme)}${item.type === "scatter" ? chartMarkerXml(item.marker, color, theme, true) : ""}${labels}${chartDataRef("xVal", x, true)}${chartDataRef("yVal", y, true)}${bubble}${item.type === "scatter" && item.smooth ? '<c:smooth val="1"/>' : ""}</c:ser>`;
  }
  const categoryColumn = encode.x ?? encode.category ?? encode.source; const valueColumn = encode.y ?? encode.value ?? encode.close ?? encode.flow;
  const category = chartReference(model, categoryColumn); const values = chartReference(model, valueColumn);
  const marker = ["line", "area", "radar"].includes(item.type) ? chartMarkerXml(item.marker, color, theme, false) : "";
  return `<c:ser>${base}${chartSeriesStyleXml(item, color, theme)}${marker}${chartDataPointsXml(item, model, theme)}${labels}${chartDataRef("cat", category, false)}${chartDataRef("val", values, true)}${item.smooth ? '<c:smooth val="1"/>' : ""}</c:ser>`;
}

function chartTitleXml(title, fallbackFont, theme = {}) {
  if (!title) return '<c:autoTitleDeleted val="1"/>';
  const config = typeof title === "string" ? { text: title } : title;
  const family = typeof config.fontFamily === "string" ? config.fontFamily : config.fontFamily?.latin ?? (typeof fallbackFont === "string" ? fallbackFont : fallbackFont?.latin) ?? "Arial";
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${textSize(config.fontSize ?? 16)}"><a:solidFill><a:srgbClr val="${colorHex(config.color ?? "#000000", theme)}"/></a:solidFill>${fontFaceXml(config.fontFamily ?? fallbackFont ?? family)}</a:rPr><a:t>${esc(config.text)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
}

function chartAxisXml(tag, id, crossId, position, config = {}, theme = {}, fallbackFont = null) {
  const axis = Array.isArray(config) ? config[0] ?? {} : config ?? {};
  const scaling = `<c:scaling><c:orientation val="${axis.reverse ? "maxMin" : "minMax"}"/>${Number.isFinite(Number(axis.max)) ? `<c:max val="${Number(axis.max)}"/>` : ""}${Number.isFinite(Number(axis.min)) ? `<c:min val="${Number(axis.min)}"/>` : ""}</c:scaling>`;
  const label = axis.label === false ? "none" : "nextTo"; const labelStyle = typeof axis.label === "object" ? axis.label : {}; const numberFormat = labelStyle.numberFormat;
  const lineProperties = (value, fallback) => {
    if (value === false) return "<a:noFill/>";
    const style = typeof value === "object" ? value : {}; const dash = { dash: "dash", dot: "dot" }[style.style] ?? "solid";
    return `<a:solidFill><a:srgbClr val="${colorHex(style.color ?? fallback, theme)}"/></a:solidFill><a:prstDash val="${dash}"/>`;
  };
  const lines = axis.gridLine === false ? "" : `<c:majorGridlines><c:spPr><a:ln w="${px((typeof axis.gridLine === "object" ? axis.gridLine.width : null) ?? 1)}">${lineProperties(axis.gridLine, "#D1D5DB")}</a:ln></c:spPr></c:majorGridlines>`;
  const titleConfig = typeof axis.title === "string" ? { text: axis.title } : axis.title; const title = titleConfig ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"${titleConfig.fontSize ? ` sz="${textSize(titleConfig.fontSize)}"` : ""}><a:solidFill><a:srgbClr val="${colorHex(titleConfig.color ?? "#000000", theme)}"/></a:solidFill>${fontFaceXml(titleConfig.fontFamily ?? fallbackFont)}</a:rPr><a:t>${esc(titleConfig.text)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></c:rich></c:tx></c:title>` : "";
  const axisWidth = (typeof axis.axisLine === "object" ? axis.axisLine.width : null) ?? 1;
  const arrow = typeof axis.axisLine === "object" ? axis.axisLine.arrow : false; const arrowValue = arrow === true ? "end" : arrow; const arrowXml = `${arrowValue === "start" || arrowValue === "both" ? '<a:headEnd type="triangle"/>' : ""}${arrowValue === "end" || arrowValue === "both" ? '<a:tailEnd type="triangle"/>' : ""}`;
  return `<c:${tag}><c:axId val="${id}"/>${scaling}<c:delete val="${axis.show === false ? 1 : 0}"/><c:axPos val="${position}"/>${lines}${title}${numberFormat ? `<c:numFmt formatCode="${esc(numberFormat)}" sourceLinked="0"/>` : tag === "valAx" ? '<c:numFmt formatCode="General" sourceLinked="1"/>' : ""}<c:tickLblPos val="${label}"/><c:spPr><a:ln w="${px(axisWidth)}">${lineProperties(axis.axisLine, "#808080")}${arrowXml}</a:ln></c:spPr>${chartTextPropertiesXml(labelStyle, fallbackFont, theme)}<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/>${tag === "catAx" ? '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' : '<c:crossBetween val="between"/>'}</c:${tag}>`;
}

function chartPart(element, theme = {}) {
  const model = chartModel(element);
  const xAxes = Array.isArray(model.chart.xAxis) ? model.chart.xAxis : [model.chart.xAxis ?? {}]; const yAxes = Array.isArray(model.chart.yAxis) ? model.chart.yAxis : [model.chart.yAxis ?? {}];
  const xAxisId = (index) => 2015039700 + index; const yAxisId = (index) => 2015039800 + index;
  const descriptor = (item) => {
    const type = item.type === "waterfall" || item.type === "heatmap" || item.type === "sankey" ? "bar" : item.type === "treemap" || item.type === "sunburst" ? "pie" : item.type;
    return { type, tag: { bar: "barChart", line: "lineChart", area: "areaChart", scatter: "scatterChart", bubble: "bubbleChart", candlestick: "stockChart", pie: Number(item.innerRadius) > 0 ? "doughnutChart" : "pieChart", radar: "radarChart" }[type] ?? "barChart" };
  };
  const groups = [];
  for (const item of model.series) { const description = descriptor(item); const xIndex = Number(item.xAxisIndex ?? 0); const yIndex = Number(item.yAxisIndex ?? 0); let group = groups.find((candidate) => candidate.tag === description.tag && candidate.xIndex === xIndex && candidate.yIndex === yIndex); if (!group) { group = { ...description, xIndex, yIndex, items: [] }; groups.push(group); } group.items.push(item); }
  let seriesIndex = 0; const hiddenLegendIndexes = [];
  const groupXml = groups.map((group) => {
    const grouping = group.items.some((item) => item.stack === "percent") ? "percentStacked" : group.items.some((item) => item.stack) ? "stacked" : "clustered";
    const intro = group.tag === "barChart" ? `<c:barDir val="${(Array.isArray(model.chart.yAxis) ? model.chart.yAxis[0] : model.chart.yAxis)?.type === "category" ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>` : group.tag === "lineChart" ? `<c:grouping val="standard"/><c:varyColors val="0"/>` : group.tag === "areaChart" ? `<c:grouping val="${grouping}"/>` : group.tag === "scatterChart" ? `<c:scatterStyle val="${group.items.some((item) => item.smooth) ? "smoothMarker" : "marker"}"/><c:varyColors val="0"/>` : group.tag === "bubbleChart" ? `<c:varyColors val="0"/>` : group.tag === "radarChart" ? `<c:radarStyle val="marker"/><c:varyColors val="0"/>` : group.tag === "stockChart" ? "" : `<c:varyColors val="1"/>`;
    const items = group.tag === "stockChart" ? group.items.flatMap((item) => [item.encode.open, item.encode.high, item.encode.low, item.encode.close].filter(Boolean).map((column) => ({ ...item, type: "line", name: column, encode: { x: item.encode.x, y: column } }))) : group.items.flatMap((item) => item.type === "waterfall" ? [{ type: "bar", name: "", stack: "value", fill: "#FFFFFF00", dataLabels: false, encode: { x: item.encode.x, y: item._waterfallBase }, _waterfallHelper: true }, item] : [item]);
    const series = items.map((item) => { const index = seriesIndex++; if (item._waterfallHelper) hiddenLegendIndexes.push(index); return chartSeriesXml(model, item, index, theme); }).join("");
    const noAxes = ["pieChart", "doughnutChart"].includes(group.tag); const axisIds = noAxes ? "" : `<c:axId val="${xAxisId(group.xIndex)}"/><c:axId val="${yAxisId(group.yIndex)}"/>`;
    const first = group.items[0] ?? {}; const wick = first.wickStyle ?? { color: "#374151", width: 1 }; const wickDash = { dash: "dash", dot: "dot" }[wick.style] ?? "solid";
    const stockExtras = group.tag === "stockChart" ? `<c:hiLowLines><c:spPr><a:ln w="${px(wick.width ?? 1)}">${fillXml(wick.color ?? "#374151", theme)}<a:prstDash val="${wickDash}"/></a:ln></c:spPr></c:hiLowLines>${first.encode?.open ? `<c:upDownBars><c:gapWidth val="150"/><c:upBars>${chartStyledColorXml(first.upBars?.fill ?? "#16A34A", first.upBars?.border, theme)}</c:upBars><c:downBars>${chartStyledColorXml(first.downBars?.fill ?? "#DC2626", first.downBars?.border, theme)}</c:downBars></c:upDownBars>` : ""}` : "";
    const categoryGap = Number(model.chart.categoryGap ?? .2); const gapWidth = model.chart.barWidth != null ? Math.round(Math.max(0, Math.min(500, (1 / Number(model.chart.barWidth) - 1) * 100))) : Math.round(Math.max(0, Math.min(500, categoryGap / Math.max(1e-9, 1 - categoryGap) * 100))); const bubbleScale = first.sizeRange ? Math.round(Math.max(5, Math.min(300, Number(first.sizeRange[1]) / Math.max(1, Math.min(...(element.bounds?.slice(2) ?? [400, 300]))) * 1000))) : 100;
    const extras = group.tag === "doughnutChart" ? `<c:firstSliceAng val="${Math.round(Number(first.startAngle ?? 0))}"/><c:holeSize val="${Math.round(Math.max(.1, Math.min(.9, Number(first.innerRadius ?? .5))) * 100)}"/>` : group.tag === "pieChart" ? `<c:firstSliceAng val="${Math.round(Number(first.startAngle ?? 0))}"/>` : group.tag === "barChart" ? `<c:gapWidth val="${gapWidth}"/><c:overlap val="${grouping === "clustered" ? -Math.round(Number(model.chart.barGap ?? 0) * 100) : 100}"/>` : group.tag === "bubbleChart" ? `<c:bubbleScale val="${bubbleScale}"/><c:showNegBubbles val="0"/><c:sizeRepresents val="${first.sizeScale === "linear" ? "w" : "area"}"/>` : stockExtras;
    return `<c:${group.tag}>${intro}${series}${extras}${axisIds}</c:${group.tag}>`;
  }).join("");
  const noAxes = groups.every((group) => ["pieChart", "doughnutChart"].includes(group.tag));
  const usedX = [...new Set(groups.filter((group) => !["pieChart", "doughnutChart"].includes(group.tag)).map((group) => group.xIndex))]; const usedY = [...new Set(groups.filter((group) => !["pieChart", "doughnutChart"].includes(group.tag)).map((group) => group.yIndex))];
  const radarOnly = groups.length > 0 && groups.every((group) => group.tag === "radarChart"); const spoke = model.chart.spokeAxis ?? {};
  const axes = noAxes ? "" : `${usedX.map((index) => { const config = radarOnly ? { show: spoke.show, label: spoke.label, axisLine: spoke.axisLine, gridLine: spoke.gridLine } : xAxes[index] ?? {}; const valueAxis = config.type === "value" || groups.filter((group) => group.xIndex === index).every((group) => ["scatterChart", "bubbleChart"].includes(group.tag)); return chartAxisXml(valueAxis ? "valAx" : "catAx", xAxisId(index), yAxisId(usedY[0] ?? 0), index % 2 ? "t" : "b", config, theme, model.chart.fontFamily); }).join("")}${usedY.map((index) => { const config = radarOnly ? { show: spoke.show, min: spoke.min ?? 0, max: spoke.max, label: spoke.label, axisLine: spoke.axisLine, gridLine: spoke.gridLine } : yAxes[index] ?? {}; const categoryAxis = config.type === "category"; return chartAxisXml(categoryAxis ? "catAx" : "valAx", yAxisId(index), xAxisId(usedX[0] ?? 0), index % 2 ? "r" : "l", config, theme, model.chart.fontFamily); }).join("")}`;
  const legendConfig = typeof model.chart.legend === "object" ? model.chart.legend : {}; const defaultLegend = !model.series.every((item) => ["waterfall", "heatmap", "treemap", "sunburst", "sankey"].includes(item.type)); const legendVisible = model.chart.legend === true || typeof model.chart.legend === "object" && model.chart.legend.show !== false || model.chart.legend == null && defaultLegend; const legend = !legendVisible || model.chart.legend === false ? "" : `<c:legend><c:legendPos val="${{ top: "t", bottom: "b", left: "l", right: "r" }[legendConfig.position] ?? "b"}"/>${hiddenLegendIndexes.map((index) => `<c:legendEntry><c:idx val="${index}"/><c:delete val="1"/></c:legendEntry>`).join("")}<c:layout/><c:overlay val="0"/>${chartTextPropertiesXml(legendConfig, model.chart.fontFamily, theme)}</c:legend>`;
  const frame = model.chart.fill || model.chart.border || model.chart.shadow ? `<c:spPr>${fillXml(model.chart.fill, theme)}${model.chart.border ? `<a:ln w="${px(model.chart.border.width ?? 1)}"><a:solidFill><a:srgbClr val="${colorHex(model.chart.border.color, theme)}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>"}${effectXml(model.chart.shadow)}</c:spPr>` : "";
  return xmlHeader(`<c:chartSpace xmlns:c="${XML_NS.c}" xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}"><c:date1904 val="0"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/><c:chart>${chartTitleXml(model.chart.title, model.chart.fontFamily, theme)}<c:plotArea><c:layout/>${groupXml}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="${model.series[0]?.nullHandling === "zero" ? "zero" : model.series[0]?.nullHandling === "connect" ? "span" : "gap"}"/><c:showDLblsOverMax val="0"/></c:chart>${frame}${model.chart.fontFamily ? chartTextPropertiesXml({}, model.chart.fontFamily, theme) : ""}<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`);
}

function timingXml(animations, shapeIds, size = [960, 540]) {
  const durations = { appear: 1, disappear: 1, pulse: 600, teeter: 1000, "rise-in": 1000, "grow-shrink": 2000, spin: 2000, "fill-color": 2000, transparency: 2000, "color-pulse": 2000, "motion-path": 2000 };
  const directionName = (direction, prefix = "from") => ({ up: `${prefix}Bottom`, down: `${prefix}Top`, left: `${prefix}Right`, right: `${prefix}Left` }[direction ?? "up"]);
  const motionPath = (path) => {
    const tokens = String(path ?? "").match(/[MLQCZ]|-?(?:\d+(?:\.\d*)?|\.\d+)/gi) ?? []; let axis = 0;
    return `${tokens.map((token) => { if (/^[MLQCZ]$/i.test(token)) { axis = 0; return token.toUpperCase() === "Z" ? "E" : token.toUpperCase(); } const divisor = axis++ % 2 ? Number(size[1] ?? 540) : Number(size[0] ?? 960); return (Number(token) / Math.max(1, divisor)).toFixed(6); }).join(" ")} E`.replace(/(?:E\s+)+E$/, "E");
  };
  const items = (animations ?? []).map((animation, index) => {
    const shapeId = shapeIds.get(animation.elementId); if (!shapeId) return "";
    const effect = animation.effect; const duration = Math.max(1, Number(animation.durationMs ?? durations[effect] ?? 500)); const base = 10 + index * 20; const easing = { "ease-in": [100000, 0], "ease-out": [0, 100000], "ease-in-out": [50000, 50000] }[animation.easing] ?? [0, 0]; const repeat = Number(animation.repeat ?? 1); const behaviorTn = (id, extra = "") => `<p:cTn id="${id}" dur="${duration}" fill="hold" accel="${easing[0]}" decel="${easing[1]}"${repeat > 1 ? ` repeatCount="${repeat * 1000}"` : ""}${extra}/>`; const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`; const behavior = (id, attrs = "") => `<p:cBhvr>${behaviorTn(id, attrs)}${target}</p:cBhvr>`; let nodes = "";
    if (effect === "appear" || effect === "disappear") nodes = `<p:set>${behavior(base + 1)}<p:to><p:strVal val="${effect === "appear" ? "visible" : "hidden"}"/></p:to></p:set>`;
    else if (["fade-in", "fade-out", "fly-in", "fly-out", "zoom-in", "zoom-out", "wipe-in", "wipe-out", "peek-in"].includes(effect)) {
      const transition = effect.endsWith("out") ? "out" : "in"; const filter = effect.startsWith("fade") ? "fade" : effect.startsWith("zoom") ? `zoom(${transition})` : effect.startsWith("wipe") ? `wipe(${animation.direction ?? "up"})` : effect.startsWith("peek") ? `peek(${directionName(animation.direction, "inFrom")})` : `slide(${directionName(animation.direction)})`; nodes = `<p:animEffect transition="${transition}" filter="${filter}">${behavior(base + 1)}</p:animEffect>`;
    } else if (["float-in", "float-out", "rise-in"].includes(effect)) {
      const outgoing = effect === "float-out"; const distance = effect === "rise-in" ? .22 : .1; const dy = (animation.direction ?? "up") === "down" ? -distance : distance; const path = `M 0 ${outgoing ? 0 : dy} L 0 ${outgoing ? -dy : 0} E`; const fade = effect === "rise-in" ? "" : `<p:animEffect transition="${outgoing ? "out" : "in"}" filter="fade">${behavior(base + 1)}</p:animEffect>`; nodes = `${fade}<p:animMotion origin="layout" path="${path}">${behavior(base + 2)}</p:animMotion>`;
    } else if (effect === "pulse" || effect === "grow-shrink") { const amount = effect === "pulse" ? 110000 : 150000; nodes = `<p:animScale>${behavior(base + 1, ' autoRev="1"')}<p:by x="${amount}" y="${amount}"/></p:animScale>`; }
    else if (effect === "spin" || effect === "teeter") nodes = `<p:animRot by="${effect === "spin" ? 21600000 : 300000}">${behavior(base + 1, effect === "teeter" ? ' autoRev="1" repeatCount="4000"' : "")}</p:animRot>`;
    else if (effect === "fill-color" || effect === "color-pulse") nodes = `<p:animClr clrSpc="rgb"${effect === "color-pulse" ? ' dir="cw"' : ""}>${behavior(base + 1, effect === "color-pulse" ? ' autoRev="1"' : "")}<p:to><a:srgbClr val="${String(animation.color).replace(/^#/, "").toUpperCase()}"/></p:to></p:animClr>`;
    else if (effect === "transparency") nodes = `<p:anim calcmode="lin" valueType="num">${behavior(base + 1)}<p:tavLst><p:tav tm="0"><p:val><p:fltVal val="1"/></p:val></p:tav><p:tav tm="100000"><p:val><p:fltVal val="${Number(animation.amount)}"/></p:val></p:tav></p:tavLst></p:anim>`;
    else if (effect === "motion-path") nodes = `<p:animMotion origin="layout" path="${motionPath(animation.path)}">${behavior(base + 1)}</p:animMotion>`;
    const trigger = animation.trigger ?? "onClick"; const nodeType = { onClick: "clickEffect", withPrevious: "withEffect", afterPrevious: "afterEffect" }[trigger]; const delay = Math.max(0, Number(animation.delayMs ?? 0));
    return `<p:par><p:cTn id="${base}" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${nodes}</p:childTnLst></p:cTn></p:par>`;
  }).join("");
  if (!items) return "";
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${items}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

function makeXlsx(element) {
  const model = chartModel(element);
  const cell = (value, reference) => {
    if (value == null) return `<c r="${reference}"/>`;
    if (typeof value === "number") return `<c r="${reference}"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const numeric = typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
    return numeric ? `<c r="${reference}"><v>${Number(value)}</v></c>` : `<c r="${reference}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
  };
  const rows = [model.cols, ...model.rows].map((row, rowIndex) => `<row r="${rowIndex + 1}">${model.cols.map((_, columnIndex) => cell(row?.[columnIndex] ?? "", `${excelColumn(columnIndex)}${rowIndex + 1}`)).join("")}</row>`).join("");
  const dimension = `A1:${excelColumn(Math.max(0, model.cols.length - 1))}${Math.max(1, model.rows.length + 1)}`;
  return makeZip({
    "[Content_Types].xml": xmlHeader(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "xl/workbook.xml" }]),
    "xl/workbook.xml": xmlHeader(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${XML_NS.r}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet", target: "worksheets/sheet1.xml" }]),
    "xl/worksheets/sheet1.xml": xmlHeader(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows}</sheetData></worksheet>`),
  });
}

function fontGuid(bytes) {
  const hex = sha256(bytes).slice(0, 32).toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

function obfuscateOfficeFont(bytes, guid) {
  const result = Buffer.from(bytes);
  const key = Buffer.from(guid.replace(/[{}-]/g, ""), "hex");
  for (let index = 0; index < Math.min(32, result.length); index += 1) result[index] ^= key[15 - (index % 16)];
  return result;
}

export function exportPptx(projectOrInput, outputPath, options = {}) {
  const project = projectOrInput?.manifestPath ? projectOrInput : loadProject(projectOrInput);
  const exportIssues = [];
  for (const page of project.pages) warnPage(page, exportIssues, project.size, project.root);
  const exportErrors = exportIssues.filter((item) => item.level === "error");
  if (exportErrors.length) throw new Error(`PPTD 校验失败：${exportErrors.map((item) => `${item.page ?? "manifest"}${item.element ? `/${item.element}` : ""}: ${item.message}`).join("；")}`);
  const remoteResources = [];
  const inspectResource = (value) => { if (resourceIsRemote(value)) remoteResources.push(value); };
  for (const font of project.manifest.customFonts ?? []) inspectResource(typeof font === "string" ? font : font?.src);
  for (const ref of manifestImageResourceRefs(project.manifest)) inspectResource(ref.src);
  for (const page of project.pages) for (const ref of pageImageResourceRefs(page)) inspectResource(ref.src);
  if (remoteResources.length && !options.force) throw new Error(`存在 ${remoteResources.length} 个未本地化的远程资源；先运行 localize，或明确使用 --force`);
  const theme = project.manifest.theme ?? {};
  const files = {};
  const media = new Map();
  const registerMedia = (source) => {
    if (typeof source !== "string" || resourceIsRemote(source) || resourceIsInline(source)) return null;
    const path = resourcePathInside(project.root, source);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`找不到本地资源：${source}`);
    const key = relative(project.root, path).replaceAll("\\", "/");
    if (!media.has(key)) media.set(key, `image${media.size + 1}${extname(path).toLowerCase() || ".bin"}`);
    return { path, key, fileName: media.get(key) };
  };
  const chartParts = [];
  const notesSlides = [];
  const embeddedFonts = [];
  if (options.embedFonts !== "none" && Array.isArray(project.manifest.customFonts)) {
    for (const font of project.manifest.customFonts) {
      const source = typeof font === "string" ? font : font?.src;
      if (!source || /^https?:\/\//i.test(source)) continue;
      const fontPath = resourcePathInside(project.root, source);
      if (!existsSync(fontPath) || !statSync(fontPath).isFile()) continue;
      const bytes = readFileSync(fontPath);
      const policy = fontEmbeddingPolicy(bytes, { force: options.embedFonts === "force" });
      if (!policy.allowed) continue;
      const guid = fontGuid(bytes);
      embeddedFonts.push({ fileName: `font${embeddedFonts.length + 1}.fntdata`, guid, policy, typeface: typeof font === "object" ? font.name ?? font.fontFamily ?? basename(source, extname(source)) : basename(source, extname(source)), bytes: obfuscateOfficeFont(bytes, guid) });
    }
  }
  const slideIds = [];
  const size = project.size ?? [960, 540];
  for (let pageIndex = 0; pageIndex < project.pages.length; pageIndex += 1) {
    const page = project.pages[pageIndex].data;
    const rels = [{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    if (page.notes != null) {
      const notesIndex = notesSlides.length + 1;
      rels.push({ id: `rId${rels.length + 1}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide", target: `../notesSlides/notesSlide${notesIndex}.xml` });
      notesSlides.push({ index: notesIndex, pageIndex, notes: page.notes });
    }
    const hyperlinkRel = (target) => {
      const existing = rels.find((rel) => rel.type.endsWith("/hyperlink") && rel.target === target);
      if (existing) return existing.id;
      const id = `rId${rels.length + 1}`; rels.push({ id, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", target, targetMode: "External" }); return id;
    };
    const shapes = [];
    const shapeIds = new Map();
    let id = 2;
    const imageRel = (value) => {
      const source = typeof value === "string" ? value : value?.src;
      const mediaItem = registerMedia(source);
      if (!mediaItem) return null;
      const target = `../media/${mediaItem.fileName}`;
      const existing = rels.find((rel) => rel.type.endsWith("/image") && rel.target === target);
      if (existing) return existing.id;
      const relId = `rId${rels.length + 1}`;
      rels.push({ id: relId, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target });
      return relId;
    };
    if (page.background?.src && !resourceIsRemote(page.background.src) && !resourceIsInline(page.background.src)) {
      const relId = imageRel(page.background);
      if (relId) shapes.push(imageXml(id++, relId, { ...page.background, elementId: "Background image", bounds: [0, 0, size[0], size[1]] }, theme));
    }
    for (const element of page.elements ?? []) {
      const type = element.elementType ?? element.type;
      const shapeId = id++;
      if (element.elementId) shapeIds.set(element.elementId, shapeId);
      if (type === "text" || type === "formula") shapes.push(textXml(shapeId, element, theme, hyperlinkRel));
      else if (type === "line") shapes.push(lineXml(shapeId, element, theme));
      else if (type === "table") shapes.push(tableXml(shapeId, element, theme, hyperlinkRel, imageRel));
      else if (type === "chart") {
        const chartType = chartModel(element).series[0]?.type;
        if (["heatmap", "treemap", "sunburst", "sankey"].includes(chartType)) { const group = editableChartGroupXml(shapeId, id, element, theme); shapes.push(group.xml); id = group.nextId; }
        else { const chartIndex = chartParts.length + 1; chartParts.push({ index: chartIndex, element }); const relId = `rId${rels.length + 1}`; rels.push({ id: relId, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart", target: `../charts/chart${chartIndex}.xml` }); shapes.push(chartXml(shapeId, relId, element)); }
      }
      else if (type === "image" && element.src && !resourceIsRemote(element.src) && !resourceIsInline(element.src)) {
        const relId = imageRel(element.src);
        if (relId) shapes.push(imageXml(shapeId, relId, element, theme));
        else shapes.push(shapeXml(shapeId, element, theme, imageRel));
      } else shapes.push(shapeXml(shapeId, element, theme, imageRel));
    }
    const bg = page.background?.type === "solid" || page.background?.color ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colorHex(page.background.color, theme)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : "";
    const transition = options.transition === "none" ? "" : "<p:transition spd=\"fast\" advClick=\"1\"><p:fade/></p:transition>";
    const timing = timingXml(page.animations, shapeIds, size);
    files[`ppt/slides/slide${pageIndex + 1}.xml`] = xmlHeader(`<p:sld xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition}${timing}</p:sld>`);
    files[`ppt/slides/_rels/slide${pageIndex + 1}.xml.rels`] = relsXml(rels);
    slideIds.push(`<p:sldId id="${256 + pageIndex}" r:id="rId${pageIndex + 6}"/>`);
  }
  if (notesSlides.length) {
    files["ppt/notesMasters/notesMaster1.xml"] = notesMasterXml();
    files["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", target: "../theme/theme1.xml" }]);
    for (const note of notesSlides) {
      files[`ppt/notesSlides/notesSlide${note.index}.xml`] = notesSlideXml(note.notes);
      files[`ppt/notesSlides/_rels/notesSlide${note.index}.xml.rels`] = relsXml([
        { id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", target: `../slides/slide${note.pageIndex + 1}.xml` },
        { id: "rId2", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster", target: "../notesMasters/notesMaster1.xml" },
      ]);
    }
  }
  const embeddedFontList = embeddedFonts.length ? `<p:embeddedFontLst>${embeddedFonts.map((font, index) => `<p:embeddedFont><p:font typeface="${esc(font.typeface)}"/><p:regular r:id="rId${project.pages.length + index + 6}"/></p:embeddedFont>`).join("")}</p:embeddedFontLst>` : "";
  const notesMasterRelId = `rId${project.pages.length + embeddedFonts.length + 6}`;
  const notesMasterList = notesSlides.length ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>` : "";
  files["ppt/presentation.xml"] = xmlHeader(`<p:presentation xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}" embedTrueTypeFonts="${embeddedFonts.length ? 1 : 0}" saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterList}<p:sldIdLst>${slideIds.join("")}</p:sldIdLst><p:sldSz cx="${px(size[0])}" cy="${px(size[1])}" type="custom"/><p:notesSz cx="${px(size[0])}" cy="${px(size[1])}"/>${embeddedFontList}</p:presentation>`);
  const presentationRels = [
    { id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", target: "theme/theme1.xml" },
    { id: "rId3", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps", target: "presProps.xml" },
    { id: "rId4", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps", target: "viewProps.xml" },
    { id: "rId5", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles", target: "tableStyles.xml" },
  ];
  for (let i = 0; i < project.pages.length; i += 1) presentationRels.push({ id: `rId${i + 6}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", target: `slides/slide${i + 1}.xml` });
  for (let i = 0; i < embeddedFonts.length; i += 1) presentationRels.push({ id: `rId${project.pages.length + i + 6}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font", target: `fonts/${embeddedFonts[i].fileName}` });
  if (notesSlides.length) presentationRels.push({ id: notesMasterRelId, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster", target: "notesMasters/notesMaster1.xml" });
  files["ppt/_rels/presentation.xml.rels"] = relsXml(presentationRels);
  files["ppt/slideMasters/slideMaster1.xml"] = xmlHeader(`<p:sldMaster xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-285750"><a:defRPr sz="3200"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", target: "../slideLayouts/slideLayout1.xml" }, { id: "rId2", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", target: "../theme/theme1.xml" }]);
  files["ppt/slideLayouts/slideLayout1.xml"] = xmlHeader(`<p:sldLayout xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", target: "../slideMasters/slideMaster1.xml" }]);
  files["ppt/presProps.xml"] = xmlHeader(`<p:presentationPr xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"/>`);
  files["ppt/viewProps.xml"] = xmlHeader(`<p:viewPr xmlns:a="${XML_NS.a}" xmlns:r="${XML_NS.r}" xmlns:p="${XML_NS.p}"><p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15611"/><p:restoredTop sz="94610"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1"><p:cViewPr varScale="1"><p:scale><a:sx n="136" d="100"/><a:sy n="136" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  files["ppt/tableStyles.xml"] = xmlHeader(`<a:tblStyleLst xmlns:a="${XML_NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  const accent1 = colorHex(theme.colors?.primary ?? "#D84F3F", theme);
  files["ppt/theme/theme1.xml"] = xmlHeader(`<a:theme xmlns:a="${XML_NS.a}" name="NeoDeck Local"><a:themeElements><a:clrScheme name="NeoDeck"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="${accent1}"/></a:accent1><a:accent2><a:srgbClr val="2563EB"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="NeoDeck"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="NeoDeck"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:solidFill><a:schemeClr val="lt2"/></a:solidFill><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  for (const item of media) files[`ppt/media/${item[1]}`] = readFileSync(resourcePathInside(project.root, item[0]));
  for (const font of embeddedFonts) files[`ppt/fonts/${font.fileName}`] = font.bytes;
  for (const item of chartParts) { files[`ppt/charts/chart${item.index}.xml`] = chartPart(item.element, theme); files[`ppt/charts/_rels/chart${item.index}.xml.rels`] = relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package", target: `../embeddings/chart${item.index}.xlsx` }]); files[`ppt/embeddings/chart${item.index}.xlsx`] = makeXlsx(item.element); }
  const overrides = ["/ppt/presentation.xml", "/ppt/slideMasters/slideMaster1.xml", "/ppt/slideLayouts/slideLayout1.xml", "/ppt/theme/theme1.xml", "/ppt/presProps.xml", "/ppt/viewProps.xml", "/ppt/tableStyles.xml", ...project.pages.map((_, i) => `/ppt/slides/slide${i + 1}.xml`), ...chartParts.map((item) => `/ppt/charts/chart${item.index}.xml`), ...(notesSlides.length ? ["/ppt/notesMasters/notesMaster1.xml", ...notesSlides.map((note) => `/ppt/notesSlides/notesSlide${note.index}.xml`)] : [])].map((part) => `<Override PartName="${part}" ContentType="${part.endsWith(".xml") && part.includes("chart") ? "application/vnd.openxmlformats-officedocument.drawingml.chart+xml" : part.includes("notesMaster") ? "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml" : part.includes("notesSlides") ? "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml" : part.includes("slideMaster") ? "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml" : part.includes("slideLayout") ? "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml" : part.includes("presProps") ? "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml" : part.includes("viewProps") ? "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml" : part.includes("tableStyles") ? "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml" : part.includes("theme") ? "application/vnd.openxmlformats-officedocument.theme+xml" : part.includes("slides") ? "application/vnd.openxmlformats-officedocument.presentationml.slide+xml" : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}"/>`).join("");
  const fontDefaults = embeddedFonts.length ? `<Default Extension="fntdata" ContentType="application/x-fontdata"/>` : "";
  const workbookOverrides = chartParts.map((item) => `<Override PartName="/ppt/embeddings/chart${item.index}.xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>`).join("");
  files["[Content_Types].xml"] = xmlHeader(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="webp" ContentType="image/webp"/>${fontDefaults}${workbookOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`);
  files["_rels/.rels"] = relsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "ppt/presentation.xml" }, { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" }, { id: "rId3", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", target: "docProps/app.xml" }]);
  files["docProps/core.xml"] = xmlHeader(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(project.title)}</dc:title></cp:coreProperties>`);
  files["docProps/app.xml"] = xmlHeader(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>open-kimi-ppt local runtime</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat></Properties>`);
  verifyOoxmlEntries(files, project.pages.length);
  const output = resolve(outputPath);
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, makeZip(files));
  return { output, pages: project.pages.length, media: media.size, charts: chartParts.length, fonts: embeddedFonts.length, notes: notesSlides.length, transition: options.transition === "none" ? "none" : "fade" };
}

export function verifyOoxmlEntries(files, expectedSlides) {
  const required = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"];
  for (const name of required) if (!(name in files)) throw new Error(`OOXML 缺少必需部件：${name}`);
  const slideNames = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slideNames.length !== expectedSlides) throw new Error(`OOXML 页面数不匹配：期望 ${expectedSlides}，实际 ${slideNames.length}`);
  for (const slideName of slideNames) {
    const ids = [...String(files[slideName]).matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((match) => match[1]);
    if (new Set(ids).size !== ids.length) throw new Error(`${slideName} 包含重复 shape id`);
  }
  for (const [relsName, source] of Object.entries(files).filter(([name]) => name.endsWith(".rels"))) {
    const owner = relsName === "_rels/.rels" ? "" : relsName.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, "$1$2");
    const base = owner ? posix.dirname(owner) : "";
    for (const match of String(source).matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*>/g)) {
      const tag = match[0];
      if (/TargetMode="External"/.test(tag)) continue;
      const target = posix.normalize(posix.join(base, match[1]));
      if (!(target in files)) throw new Error(`${relsName} 引用了缺失部件：${target}`);
    }
  }
  return { slides: slideNames.length, parts: Object.keys(files).length };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(entries) {
  const chunks = []; const central = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); const nameBuffer = Buffer.from(name);
    const crc = crc32(data); const compressed = data.length > 128 ? deflateRawSync(data) : data; const method = compressed === data ? 0 : 8;
    const local = Buffer.alloc(30 + nameBuffer.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26); nameBuffer.copy(local, 30); chunks.push(local, compressed);
    const entry = Buffer.alloc(46 + nameBuffer.length); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(0, 12); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBuffer.length, 28); nameBuffer.copy(entry, 46); entry.writeUInt32LE(offset, 42); central.push(entry); offset += local.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 8); end.writeUInt16LE(0, 10); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...chunks, centralBuffer, end]);
}

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

/** Read the OpenType OS/2 fsType bits without a font parsing dependency. */
export function fontEmbeddingPolicy(bytes, { force = false } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 12 || buffer.readUInt32BE(0) !== 0x00010000 && buffer.readUInt32BE(0) !== 0x4f54544f) return { allowed: false, reason: "not-an-opentype-font" };
  const tables = buffer.readUInt16BE(4); let fsType = 0;
  for (let index = 0; index < tables; index += 1) {
    const offset = 12 + index * 16;
    if (offset + 16 > buffer.length) break;
    if (buffer.toString("ascii", offset, offset + 4) === "OS/2") {
      const tableOffset = buffer.readUInt32BE(offset + 8);
      if (tableOffset + 10 <= buffer.length) fsType = buffer.readUInt16BE(tableOffset + 8);
      break;
    }
  }
  const restricted = (fsType & 0x0002) !== 0;
  return { allowed: force || !restricted, forced: force, fsType, reason: restricted && !force ? "restricted-license" : "license-permits-embedding" };
}
