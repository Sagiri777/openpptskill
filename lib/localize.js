import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { findManifest, loadProject, sha256 } from "./pptd-core.js";

const MAX_RESOURCE_BYTES = 50 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/gif", ".gif"], ["image/svg+xml", ".svg"],
  ["font/ttf", ".ttf"], ["font/otf", ".otf"], ["font/woff", ".woff"], ["font/woff2", ".woff2"],
]);

function extensionFor(url, contentType) {
  const fromType = MIME_EXTENSIONS.get(String(contentType || "").split(";", 1)[0].toLowerCase());
  if (fromType) return fromType;
  try {
    const suffix = extname(new URL(url).pathname).toLowerCase();
    if (/^\.(?:jpe?g|png|gif|svg|ttf|otf|woff2?)$/.test(suffix)) return suffix === ".jpeg" ? ".jpg" : suffix;
  } catch { /* malformed URLs are reported by fetch below */ }
  return ".bin";
}

async function download(url) {
  if (!/^https:\/\//i.test(url)) throw new Error(`仅允许本地化 HTTPS 资源：${url}`);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`资源下载失败 ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESOURCE_BYTES) throw new Error(`资源超过 50 MiB：${url}`);
  return { buffer, contentType: response.headers.get("content-type") || "" };
}

export async function localizeProject(input, { force = false } = {}) {
  const manifestPath = findManifest(input);
  const project = loadProject(manifestPath);
  const sources = [{ path: manifestPath, source: readFileSync(manifestPath, "utf8") }, ...project.pages.map((page) => ({ path: page.absolutePath, source: page.source }))];
  const urls = new Set();
  for (const item of sources) for (const match of item.source.matchAll(/https:\/\/[^\s"'<>]+/gi)) urls.add(match[0].replace(/[),]}]+$/, ""));
  if (!urls.size) return { manifest: manifestPath, localized: [], unchanged: true };
  const mediaDir = resolve(project.root, "media"); mkdirSync(mediaDir, { recursive: true });
  const replacements = new Map();
  for (const url of urls) {
    const fetched = await download(url);
    const target = `media/${sha256(fetched.buffer)}${extensionFor(url, fetched.contentType)}`;
    const targetPath = resolve(project.root, target);
    if (force || !existsSync(targetPath)) writeFileSync(targetPath, fetched.buffer);
    replacements.set(url, target);
  }
  for (const item of sources) {
    let next = item.source;
    for (const [url, target] of replacements) next = next.split(url).join(target);
    if (next !== item.source) writeFileSync(item.path, next, "utf8");
  }
  return { manifest: manifestPath, localized: [...replacements].map(([url, path]) => ({ url, path })), unchanged: false };
}
