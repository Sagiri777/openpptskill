#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportPptx, findManifest, loadProject, renderPageSvg, resolveProjectResource, validateProject } from "../lib/pptd-core.js";
import { localizeProject } from "../lib/localize.js";
import { startEditorServer } from "../lib/editor-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = join(packageRoot, "skills", "open-kimi-ppt");

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) throw new Error(`Node.js 18+ is required; found ${process.version}`);
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return parsed;
}

function takeValue(args, name) {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArguments(argv) {
  const args = [...argv];
  const command = ["install", "serve", "desktop", "validate", "render", "export", "localize"].includes(args[0]) ? args.shift() : "install";
  const options = { command, open: false, json: false, force: false, transition: "fade", embedFonts: "auto", format: "png", scale: 1 };
  if (command === "serve") options.port = 55173;
  if (command === "install") options.target = undefined;
  if (command === "render") options.output = undefined;
  if (command === "export") options.output = undefined;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--force") { options.force = true; continue; }
    if (command === "install" && arg === "--target") { options.target = resolve(takeValue(args, "--target")); continue; }
    if ((command === "serve" || command === "desktop") && arg === "--port") { options.port = parseNumber(takeValue(args, "--port"), "--port"); continue; }
    if ((command === "serve" || command === "desktop") && arg === "--open") { options.open = true; continue; }
    if (command === "validate" && arg === "--json") { options.json = true; continue; }
    if (command === "render" && arg === "--output") { options.output = resolve(takeValue(args, "--output")); continue; }
    if (command === "render" && arg === "--format") { options.format = takeValue(args, "--format").toLowerCase(); if (!["png", "svg"].includes(options.format)) throw new Error("--format must be png or svg"); continue; }
    if (command === "render" && arg === "--scale") { options.scale = Number(takeValue(args, "--scale")); if (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 8) throw new Error("--scale must be between 0 and 8"); continue; }
    if (command === "export" && (arg === "--output" || arg === "-o")) { options.output = resolve(takeValue(args, "--output")); continue; }
    if (command === "export" && arg === "--transition") { options.transition = takeValue(args, "--transition"); if (!["fade", "none"].includes(options.transition)) throw new Error("--transition must be fade or none"); continue; }
    if (command === "export" && arg === "--embed-fonts") { options.embedFonts = takeValue(args, "--embed-fonts"); if (!["auto", "force", "none"].includes(options.embedFonts)) throw new Error("--embed-fonts must be auto, force or none"); continue; }
    if (["validate", "render", "export", "localize", "desktop"].includes(command) && !options.input) { options.input = resolve(arg); continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function help(command) {
  if (command === "serve") return `Usage: open-kimi-ppt-skills serve [--port N] [--open]\n\nStart the local browser editor.`;
  if (command === "desktop") return `Usage: open-kimi-ppt-skills desktop [project] [--open]\n\nStart the local desktop-compatible editor host.`;
  if (command === "validate") return `Usage: open-kimi-ppt-skills validate <project> [--json]`;
  if (command === "render") return `Usage: open-kimi-ppt-skills render <project> --output <dir> [--format png|svg] [--scale 2]`;
  if (command === "export") return `Usage: open-kimi-ppt-skills export <project> [-o deck.pptx] [--transition fade|none] [--embed-fonts auto|force|none] [--force]`;
  if (command === "localize") return `Usage: open-kimi-ppt-skills localize <project> [--force]`;
  return `Usage: open-kimi-ppt-skills install [--target directory]\n       open-kimi-ppt-skills serve [--port N] [--open]\n       open-kimi-ppt-skills validate|render|export|localize ...`;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref();
}

function startDesktop(project) {
  const executable = [
    join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"),
    process.platform === "darwin" ? "/Applications/Electron.app/Contents/MacOS/Electron" : "",
  ].find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("Electron is not installed. Run npm install, then retry `open-kimi-ppt-skills desktop`.");
  const args = [join(packageRoot, "desktop", "main.js")];
  if (project) args.push("--project", project);
  const child = spawn(executable, args, { cwd: packageRoot, stdio: "inherit", env: { ...process.env, NEODECK_PROJECT: project ?? "" } });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code === 0) resolvePromise();
      else reject(new Error(`Electron exited with status ${code}`));
    });
  });
}

function installSkill(target) {
  const destination = join(target ?? join(homedir(), ".agents", "skills"), "open-kimi-ppt");
  const replaced = existsSync(destination);
  mkdirSync(destination, { recursive: true });
  if (replaced) rmSync(destination, { recursive: true, force: true });
  // Keep installation dependency-free and avoid copying generated caches.
  cpSync(skillSource, destination, {
    recursive: true,
    filter: (item) => {
      const name = item.split(/[\\/]/).at(-1);
      return name !== ".DS_Store" && name !== "_user_meta.json" && name !== "__pycache__" && !name.endsWith(".pyc");
    },
  });
  const runtime = join(destination, "runtime");
  mkdirSync(runtime, { recursive: true });
  for (const directory of ["bin", "editor", "lib"]) cpSync(join(packageRoot, directory), join(runtime, directory), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(runtime, "package.json"));
  console.log(`${replaced ? "Updated" : "Installed"} open-kimi-ppt at ${destination}`);
}

function chromiumExecutable() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"), join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe")]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function renderPng(svg, target, size, scale) {
  const executable = chromiumExecutable();
  if (!executable) throw new Error("PNG rendering requires a local Chromium/Chrome/Edge installation; use --format svg otherwise");
  const temporary = mkdtempSync(join(tmpdir(), "open-kimi-ppt-render-"));
  try {
    const html = join(temporary, "page.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${size[0]}px;height:${size[1]}px;overflow:hidden;background:white}svg{display:block;width:100%;height:100%}</style>${svg}`);
    const processResult = spawnSync(executable, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", "--host-resolver-rules=MAP * 0.0.0.0", `--user-data-dir=${join(temporary, "profile")}`, `--force-device-scale-factor=${scale}`, `--window-size=${Math.round(size[0])},${Math.round(size[1])}`, `--screenshot=${target}`, pathToFileURL(html).href], { encoding: "utf8", timeout: 60_000 });
    if (processResult.status !== 0 || !existsSync(target)) throw new Error(`Chromium PNG render failed: ${(processResult.stderr || processResult.stdout).slice(-1000)}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function runRender(options) {
  if (!options.input || !options.output) throw new Error("render requires <project> and --output <dir>");
  const project = loadProject(options.input); mkdirSync(options.output, { recursive: true });
  const images = [];
  for (let index = 0; index < project.pages.length; index += 1) {
    const page = project.pages[index]; const svg = renderPageSvg(page.data, { size: project.size, theme: project.manifest.theme, resourceResolver: (value) => { if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return ""; const path = resolveProjectResource(project.root, value); return pathToFileURL(path).href; } });
    const stem = String(index + 1).padStart(2, "0"); const target = join(options.output, `${stem}.${options.format}`);
    if (options.format === "svg") writeFileSync(target, svg);
    else renderPng(svg, target, project.size, options.scale);
    images.push(target);
  }
  console.log(JSON.stringify({ output: options.output, pages: images.length, format: options.format, images }, null, 2));
}

async function run(options) {
  assertNodeVersion();
  if (options.help) { console.log(help(options.command)); return; }
  if (options.command === "install") { installSkill(options.target); return; }
  if (options.command === "desktop") { await startDesktop(options.input); return; }
  if (options.command === "serve") {
    const started = await startEditorServer({ port: options.port }); console.log(`Local PPTD editor is running at ${started.url}`); if (options.open) openBrowser(started.url); const stop = () => started.server.close(() => process.exit(0)); process.once("SIGINT", stop); process.once("SIGTERM", stop); return;
  }
  if (!options.input) throw new Error(`${options.command} requires a project path`);
  if (options.command === "validate") { const result = validateProject(options.input); if (options.json) console.log(JSON.stringify({ valid: result.valid, errors: result.errors, warnings: result.warnings }, null, 2)); else { console.log(`${result.valid ? "valid" : "invalid"}: ${findManifest(options.input)}`); for (const issue of [...result.errors, ...result.warnings]) console.log(`${issue.level}: ${issue.message}`); } if (!result.valid) process.exitCode = 1; return; }
  if (options.command === "render") { await runRender(options); return; }
  if (options.command === "export") { const project = loadProject(options.input); const output = options.output ?? resolve(project.root, `${project.title || "presentation"}.pptx`); if (!options.force && existsSync(output)) throw new Error(`输出文件已存在（使用 --force 覆盖）：${output}`); console.log(JSON.stringify(exportPptx(project, output, options), null, 2)); return; }
  if (options.command === "localize") { console.log(JSON.stringify(await localizeProject(options.input, options), null, 2)); return; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) run(parseArguments(process.argv.slice(2))).catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
