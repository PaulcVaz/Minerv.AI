import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { run } from "../server/media.ts";
import { previewPlan } from "../shared/preview.ts";
import { active, editorStructure, pendingSegments, segmentImages, timeline, type Project } from "../shared/types.ts";

test("imported MOV supplies both AI boundaries and keeps its audio in export", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "studio-import-"));
  const { app, jobs, store } = createApp(root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (route: string, body: unknown, method = "POST") =>
    fetch(base + "/api" + route, {
      method,
      ...(body instanceof FormData
        ? { body }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  const update = async (route: string, body: unknown, method?: string) => {
    const response = await request(route, body, method);
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result as Project;
  };
  const idle = async () => {
    while (jobs.running) await new Promise((resolve) => setTimeout(resolve, 30));
  };
  try {
    const source = path.join(root, "source.mov");
    await run([
      "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24:d=1",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-c:a", "aac", source,
    ]);
    let p = await update("/projects", { name: "Vídeo importado" });
    const route = `/projects/${p.id}`;
    await update(route, { format: { ratio: "16:9", resolution: 720, fps: 24 } }, "PATCH");
    const upload = new FormData();
    upload.append("video", new Blob([new Uint8Array(await readFile(source))]), "source.mov");
    p = await update(route + "/videos", upload);
    const video = p.videos![0];
    assert.equal(video.durationMs, 2000);
    for (const [image, channel] of [[video.firstImage, 0], [video.lastImage, 2]] as const) {
      const pixel = await sharp(await readFile(path.join(root, image))).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer();
      assert.ok(pixel[channel] > 200);
    }
    const place = route + `/videos/${video.id}/clips`;
    const empty = editorStructure(p);
    p = await update(place, { startTimeMs: 0 });
    assert.deepEqual(p.keyframes.map((k) => [k.timeMs, k.image]), [[0, video.firstImage], [2000, video.lastImage]]);
    p = await update(route + "/structure", { expected: editorStructure(p), target: empty });
    assert.equal(p.keyframes.length, 0);
    assert.equal(p.videos?.length, 1);

    p = await update(route + "/keyframes", { timeMs: 0 });
    p = await update(route + "/keyframes", { timeMs: 1000 });
    p = await update(route + "/keyframes", { timeMs: 3000 });
    p = await update(route + "/keyframes", { timeMs: 4000 });
    // Seed an existing image so the shared boundary requires explicit replacement.
    p.keyframes[1].image = video.lastImage;
    store.save(p);
    const before = editorStructure(p);
    assert.equal((await request(place, { startTimeMs: 1000 })).status, 409);
    assert.equal((await request(place, { startTimeMs: 500 })).status, 400);
    p = await update(place, { startTimeMs: 1000, boundaryImages: [video.lastImage, null] });
    const after = editorStructure(p);
    assert.equal(p.keyframes.length, 4);
    p = await update(route + "/structure", { expected: after, target: before });
    assert.equal(pendingSegments(p).length, 3);
    assert.equal(p.keyframes[1].image, video.lastImage);
    p = await update(route + "/structure", { expected: before, target: after });
    const [lead, imported, tail] = timeline(p);
    assert.equal(segmentImages(p, lead)[1], video.firstImage);
    assert.equal(segmentImages(p, tail)[0], video.lastImage);
    assert.equal(active(imported)?.importedVideoId, video.id);
    assert.deepEqual(pendingSegments(p).map((s) => s.id), [lead.id, tail.id]);
    assert.equal(previewPlan(p).find((part) => part.startMs === 1000)?.visual.kind, "video");
    assert.equal((await request(route + `/segments/${imported.id}/generate`, {})).status, 400);

    for (const s of [lead, tail]) {
      await update(route + `/segments/${s.id}`, { model: "Demo" }, "PATCH");
      await update(route + `/segments/${s.id}/generate`, {});
    }
    await idle();
    p = store.get(p.id);
    assert.equal(pendingSegments(p).length, 0);
    assert.equal(active(timeline(p)[0])?.inputImages?.[1], video.firstImage);
    assert.equal(active(timeline(p)[2])?.inputImages?.[0], video.lastImage);
    const exported = await request(route + "/export", {});
    assert.equal(exported.status, 202);
    await idle();
    const job = store.get(p.id).jobs.find((j) => j.kind === "export");
    assert.equal(job?.status, "Completed", job?.error);
    const audio = path.join(root, "exported.pcm");
    await run(["-ss", "1.25", "-i", path.join(root, job!.file!), "-t", "0.25", "-map", "0:a:0", "-f", "s16le", audio]);
    const samples = await readFile(audio);
    assert.ok(samples.some((sample) => sample !== 0), "the imported audio remains audible");

    const silent = path.join(root, "silent.mp4");
    await run(["-i", source, "-map", "0:v:0", "-c:v", "copy", silent]);
    const silentUpload = new FormData();
    silentUpload.append("video", new Blob([new Uint8Array(await readFile(silent))]), "silent.mp4");
    p = await update(route + "/videos", silentUpload);
    assert.equal(p.videos?.[1].durationMs, 2000);
  } finally {
    await idle();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
