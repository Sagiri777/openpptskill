import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exportPptx } from "./pptd-core.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEditorDirectory = resolve(packageRoot, "editor");
const browserModulePaths = new Map([
  ["/lib/pptd-core.js", resolve(packageRoot, "lib", "pptd-core.js")],
  ["/lib/preset-geometries.js", resolve(packageRoot, "lib", "preset-geometries.js")],
]);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function respond(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

function safeProjectFile(root, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || requestedPath.includes("\0")) throw new Error("项目文件路径无效");
  const candidate = resolve(root, requestedPath);
  const local = relative(root, candidate);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new Error(`项目文件越过临时目录：${requestedPath}`);
  return candidate;
}

export function createEditorServer({ editorDirectory = defaultEditorDirectory } = {}) {
  const root = resolve(editorDirectory);
  const rootPrefix = `${root}${sep}`;

  return createServer((request, response) => {
    if (request.method === "POST" && request.url?.split("?", 1)[0] === "/api/export") {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => { size += chunk.length; if (size <= 200 * 1024 * 1024) chunks.push(chunk); });
      request.on("end", () => {
        let temporary;
        try {
          if (size > 200 * 1024 * 1024) throw new Error("导出请求超过 200 MiB");
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!payload.project || !Array.isArray(payload.project.pages)) throw new Error("导出请求缺少 project.pages");
          temporary = mkdtempSync(`${tmpdir()}/open-kimi-ppt-export-`);
          const manifestPath = payload.project.manifestPath || "presentation.pptd";
          const manifestDirectory = dirname(manifestPath).replaceAll("\\", "/").replace(/^\.\/?$/, "");
          const projectRoot = manifestDirectory ? safeProjectFile(temporary, manifestDirectory) : temporary;
          mkdirSync(projectRoot, { recursive: true });
          for (const media of payload.project.media ?? []) {
            const mediaPath = safeProjectFile(temporary, media.path);
            const bytes = Buffer.from(String(media.data ?? ""), "base64");
            mkdirSync(dirname(mediaPath), { recursive: true });
            writeFileSync(mediaPath, bytes);
            // Browser uploads are indexed from the selected directory. PPTD
            // resource paths, however, are relative to the manifest folder.
            // Also mirror the prefixed form into that folder for nested decks.
            const normalizedMediaPath = String(media.path).replaceAll("\\", "/");
            const localMediaPath = manifestDirectory && normalizedMediaPath.startsWith(`${manifestDirectory}/`)
              ? safeProjectFile(projectRoot, normalizedMediaPath.slice(manifestDirectory.length + 1))
              : manifestDirectory ? safeProjectFile(projectRoot, normalizedMediaPath) : mediaPath;
            if (localMediaPath !== mediaPath) {
              mkdirSync(dirname(localMediaPath), { recursive: true });
              writeFileSync(localMediaPath, bytes);
            }
          }
          const project = { ...payload.project, root: projectRoot, manifestPath, pages: payload.project.pages.map((page, index) => { const path = page.path || `pages/${String(index + 1).padStart(2, "0")}.page`; const absolutePath = safeProjectFile(projectRoot, path); mkdirSync(dirname(absolutePath), { recursive: true }); writeFileSync(absolutePath, page.source || "", "utf8"); return { ...page, path, absolutePath }; }) };
          const output = resolve(temporary, "presentation.pptx");
          exportPptx(project, output, payload.options || {});
          const data = readFileSync(output);
          response.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "Content-Length": data.length, "Content-Disposition": `attachment; filename="${String(project.title || "presentation").replace(/[^\w.-]+/g, "_")}.pptx"`, "Cache-Control": "no-store" });
          response.end(data);
        } catch (error) {
          respond(response, 400, error.message || "导出失败");
        } finally {
          if (temporary) rmSync(temporary, { recursive: true, force: true });
        }
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, "Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      respond(response, 400, "Bad Request");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";
    const browserModulePath = browserModulePaths.get(pathname);
    const filePath = browserModulePath ?? resolve(root, `.${pathname}`);
    if (!browserModulePath && filePath !== root && !filePath.startsWith(rootPrefix)) {
      respond(response, 403, "Forbidden");
      return;
    }

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      respond(response, 404, "Not Found");
      return;
    }

    if (!stats.isFile()) {
      respond(response, 404, "Not Found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
}

export function startEditorServer({ host = "127.0.0.1", port = 55173 } = {}) {
  const server = createEditorServer();

  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, url: `http://${host}:${actualPort}/` });
    });
  });
}
