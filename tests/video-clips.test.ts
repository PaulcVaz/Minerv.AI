import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { extractVideoFrame } from "../server/media.ts";
import { previewPlan } from "../shared/preview.ts";
import { active, editorStructure, timeline, timelineDurationMs, type Project } from "../shared/types.ts";

test("detach and cut reuse the source, and export fills gaps between clips", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "studio-video-clips-"));
  const { app, store, jobs } = createApp(root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects`;
  const request = async (route: string, method: string, body?: unknown, status = 200) => {
    const response = await fetch(base + route, {
      method,
      ...(body instanceof FormData ? { body } : {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as Project;
  };
  const idle = async () => {
    while (jobs.running) await new Promise((resolve) => setTimeout(resolve, 25));
  };
  try {
    const p = await request("", "POST", { name: "Sequências" }, 201);
    const route = "/" + p.id;
    await request(route, "PATCH", { format: { ratio: "16:9", resolution: 720, fps: 30 } });
    const form = new FormData();
    form.append("video", new Blob([new Uint8Array(await readFile("assets/demo.mp4"))]), "demo.mp4");
    const uploaded = await request(route + "/videos", "POST", form, 201);
    const source = uploaded.videos![0];
    const place = route + "/videos/" + source.id + "/clips";
    await request(place, "POST", { startTimeMs: 0 }, 201);
    const start = source.durationMs + 10;
    const withGap = await request(place, "POST", { startTimeMs: start }, 201);
    const [first, , second] = timeline(withGap);
    assert.equal(previewPlan(withGap).find((part) => part.startMs === source.durationMs)?.visual.kind, "placeholder");
    const joined = await request(route + "/video-clips/join", "POST", { clipIds: [second.id, first.id] });
    assert.equal(joined.videoClips?.[0].startTimeMs, source.durationMs);
    assert.equal(joined.videoClips?.[0].generationId, active(second)?.id);
    assert.equal(timelineDurationMs(joined), 2 * source.durationMs);
    await request(route + "/structure", "POST", {
      expected: editorStructure(joined), target: editorStructure(withGap),
    });
    const detached = await request(route + `/segments/${second.id}/detach`, "POST");
    const [clip] = detached.videoClips!;
    assert.equal(clip.generationId, active(second)!.id);
    assert.equal(active(timeline(detached)[0])?.id, active(first)?.id);
    assert.equal(active(timeline(detached)[2]), undefined);
    const restored = await request(route + "/structure", "POST", {
      expected: editorStructure(detached), target: editorStructure(withGap),
    });
    assert.equal(active(timeline(restored)[2])?.id, active(second)?.id);
    assert.equal(restored.videoClips?.length, 0);

    const cut = await request(route + `/segments/${second.id}/detach`, "POST", { cutTimeMs: start + 1731 });
    const [left, right] = cut.videoClips!;
    assert.equal(left.durationMs, 1731);
    assert.equal(right.startTimeMs, start + 1731);
    assert.equal(right.sourceStartMs, 1731);
    const split = await request(route + `/video-clips/${right.id}/split`, "POST", { timeMs: right.startTimeMs + 777 });
    const tail = split.videoClips!.at(-1)!;
    assert.equal(tail.sourceStartMs, 2508);
    const moved = await request(route + `/video-clips/${tail.id}`, "PATCH", { startTimeMs: tail.startTimeMs + 1000 });
    const preview = previewPlan(moved).find((part) => part.startMs === tail.startTimeMs + 1000);
    assert.equal(preview?.visual.kind, "video");
    if (preview?.visual.kind === "video") {
      assert.equal(preview.visual.originMs, tail.startTimeMs + 1000 - tail.sourceStartMs);
    }
    await request(route + "/export", "POST", {}, 202);
    await idle();
    const job = store.get(p.id).jobs.at(-1)!;
    assert.equal(job.status, "Completed", job.error);
    const frame = path.join(root, "gap.webp");
    await extractVideoFrame(path.join(root, job.file!), tail.startTimeMs + 500, job.format, frame);
    const pixels = await sharp(await readFile(frame)).raw().toBuffer();
    assert.ok(pixels.every((channel) => channel < 12), "the empty second is filled with black");
  } finally {
    await idle();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
