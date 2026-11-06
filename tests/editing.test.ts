import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.ts";
import {
  editorStructure,
  timeline,
  segmentImages,
  stale,
  type Project,
} from "../shared/types.ts";

test("optional anchors, image changes and structural undo preserve a completed background generation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-editing-"));
  const { app, store } = createApp(root),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const request = async (url: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    let p = (await request("/projects", "POST", { name: "Editing" }))
      .body as Project;
    const route = "/projects/" + p.id;
    p = (await request(route + "/keyframes", "POST", { timeMs: 0 })).body;
    p = (await request(route + "/keyframes", "POST", { timeMs: 4000 })).body;
    assert.equal(p.keyframes[0].image, undefined);
    assert.equal((await request(route + "/preview", "POST")).status, 202);
    assert.equal((await request(route + "/export", "POST")).status, 409);
    const before = editorStructure(p),
      sid = timeline(p)[0].id;
    p = (await request(route + "/keyframes", "POST", { timeMs: 2000 })).body;
    const after = editorStructure(p);
    const s = p.segments.find((s) => s.id === sid)!;
    s.generations.push({
      id: "completed-in-background",
      status: "Completed",
      settings: { ...s.settings },
      durationMs: 4000,
      format: { ...p.format },
      createdAt: "now",
      file: "preserved.mp4",
      inputImages: segmentImages(p, s),
    });
    s.activeId = s.generations[0].id;
    store.save(p);
    p = (
      await request(route + "/structure", "POST", {
        expected: after,
        target: before,
      })
    ).body;
    assert.equal(timeline(p)[0].activeId, "completed-in-background");
    assert.equal(timeline(p)[0].generations[0].file, "preserved.mp4");
    p = (
      await request(route + "/structure", "POST", {
        expected: before,
        target: after,
      })
    ).body;
    assert.deepEqual(editorStructure(p), after);
    assert.equal(
      (
        await request(route + "/structure", "POST", {
          expected: before,
          target: after,
        })
      ).status,
      409,
    );
    p.media.push({ id: "image", name: "Image", image: "image.webp" });
    store.save(p);
    const kid = before.keyframes[0].id;
    p = (
      await request(route + "/keyframes/" + kid, "PATCH", { mediaId: "image" })
    ).body;
    assert.equal(p.keyframes.find((k) => k.id === kid)?.image, "image.webp");
    assert.equal(
      stale(
        p,
        p.segments.find((s) => s.id === sid)!,
      ),
      true,
    );
    p = (await request(route + "/keyframes/" + kid, "PATCH", { image: null }))
      .body;
    assert.equal(p.keyframes.length, 3);
    assert.equal(p.keyframes.find((k) => k.id === kid)?.image, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
