import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createEditorServer } from "../lib/editor-server.js";

async function withServer(callback) {
  const server = createEditorServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("serves the PPTD editor and its JavaScript modules", async () => {
  await withServer(async (url) => {
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /^text\/html/);
    const indexText = await index.text();
    assert.match(indexText, /打开项目/);
    assert.doesNotMatch(indexText, /iframe|登录/);

    const app = await fetch(`${url}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type"), /^text\/javascript/);
    const appText = await app.text();
    assert.match(appText, /renderPageSvg/);
    assert.doesNotMatch(appText, /kimi\.com|moonshot|Penpal|iframe/);

    const core = await fetch(`${url}/lib/pptd-core.js`);
    assert.equal(core.status, 200);
    assert.match(core.headers.get("content-type"), /^text\/javascript/);
    assert.match(await core.text(), /export function renderPageSvg/);

    const geometries = await fetch(`${url}/lib/preset-geometries.js`);
    assert.equal(geometries.status, 200);
    assert.match(geometries.headers.get("content-type"), /^text\/javascript/);
    assert.match(await geometries.text(), /export const ECMA_PRESET_GEOMETRIES/);
  });
});

test("returns 404 for files outside the packaged editor", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/missing.js`);
    assert.equal(response.status, 404);
  });
});

test("supports HEAD requests without a response body", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/styles.css`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });
});
