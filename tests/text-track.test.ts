import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { composeTimeline, extractVideoFrame, run } from "../server/media.ts";
import { textAt, textSvg, defaultText, type TextClip } from "../shared/text.ts";
import {
  editorStructure,
  timelineDurationMs,
  type Format,
  type Project,
} from "../shared/types.ts";

test("text routes keep edits atomic, restore history and export a text-only project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "studio-text-"));
  const { app, store, jobs } = createApp(root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects`;
  const request = async (
    route: string,
    method: string,
    body?: unknown,
    status = 200,
  ) => {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as Project;
  };
  try {
    const project = await request("", "POST", { name: "Texto" }, 201);
    const route = "/" + project.id;
    const before = editorStructure(project);
    const added = await request(
      route + "/text-clips",
      "POST",
      { startTimeMs: 0 },
      201,
    );
    const clip = added.textClips![0];
    assert.equal(added.selectedId, clip.id);
    assert.equal(clip.durationMs, 3000);
    await request(route + "/text-clips", "POST", { startTimeMs: 2999 }, 409);
    const consecutive = await request(
      route + "/text-clips",
      "POST",
      { startTimeMs: 3000, durationMs: 500 },
      201,
    );
    assert.equal(timelineDurationMs(consecutive), 3500);
    const edited = await request(route + "/text-clips/" + clip.id, "PATCH", {
      content: "Ação & emoção\n<Minerv.AI>",
      durationMs: 1000,
      startTimeMs: 1000,
      color: "#ffddaa",
      size: 64,
    });
    const after = editorStructure(edited);
    await request(
      route + "/text-clips/" + clip.id,
      "PATCH",
      { startTimeMs: 2500 },
      409,
    );
    await request(
      route + "/structure",
      "POST",
      {
        expected: after,
        target: {
          ...after,
          textClips: [
            after.textClips.find((item) => item.id === clip.id)!,
            { ...clip, id: "overlap", startTimeMs: 1100 },
          ],
        },
      },
      409,
    );
    assert.deepEqual(editorStructure(await request(route, "GET")), after);
    await request(route + "/structure", "POST", {
      expected: after,
      target: before,
    });
    const redone = await request(route + "/structure", "POST", {
      expected: before,
      target: after,
    });
    assert.deepEqual(editorStructure(redone), after);
    const deleted = await request(
      route + "/text-clips/" + consecutive.textClips![1].id,
      "DELETE",
    );
    assert.equal(deleted.textClips?.length, 1);
    await request(route, "PATCH", {
      format: { ratio: "9:16", resolution: 720, fps: 24 },
    });
    await request(route + "/export", "POST", {}, 202);
    // Editing while the export runs must not change its snapshot.
    await request(route + "/text-clips/" + clip.id, "DELETE");
    while (jobs.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const job = store.get(project.id).jobs.at(-1)!;
    assert.equal(job.status, "Completed", job.error);
    await assertTextFrames(
      root,
      path.join(root, job.file!),
      job.format,
      [500, 1250, 1750],
      [false, true, true],
    );
  } finally {
    while (jobs.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("text appears only in its interval over horizontal video and preserves audio", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "studio-text-video-"));
  const format: Format = { ratio: "16:9", resolution: 720, fps: 24 };
  const clip: TextClip = {
    ...defaultText,
    id: "title",
    startTimeMs: 1000,
    durationMs: 1000,
    content: "Vídeo\nAção",
  };
  try {
    assert.equal(textAt([clip], 999), undefined);
    assert.equal(textAt([clip], 1000), clip);
    assert.equal(textAt([clip], 2000), undefined);
    assert.match(textSvg(clip, format), /Ação/);
    const video = path.join(dir, "source.mp4");
    const output = path.join(dir, "output.mp4");
    await run([
      "-f",
      "lavfi",
      "-i",
      "color=0x500000:s=320x180:r=24:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      video,
    ]);
    await composeTimeline(
      [{ kind: "video", file: video, durationMs: 3000,
        transform: { x: 0.1, y: 0, scale: 0.5, rotation: 30 } }],
      format,
      output,
      [clip],
      { [clip.id]: { x: 0, y: -0.55, scale: 1.4, rotation: 12 } },
    );
    await assertTextFrames(
      dir,
      output,
      format,
      [500, 1500, 2500],
      [false, true, false],
    );
    const firstFrame = await readFile(path.join(dir, "frame-0.webp"));
    const center = await sharp(firstFrame).extract({ left: 768, top: 360, width: 1, height: 1 }).raw().toBuffer();
    const corner = await sharp(firstFrame).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(center[0] > 50 && corner[0] < 10, "scaled and translated video is clipped to a black canvas");
    const during = await readFile(path.join(dir, "frame-1.webp"));
    const upper = await sharp(during).extract({ left: 0, top: 0, width: 1280, height: 360 }).raw().toBuffer();
    assert.ok(upper.some((channel) => channel > 100), "transformed text appears above its original bottom anchor");
    const pcm = path.join(dir, "audio.pcm");
    await run(["-i", output, "-map", "0:a:0", "-t", "0.5", "-f", "s16le", pcm]);
    const samples = await readFile(pcm);
    assert.ok(samples.some((sample) => sample !== 0));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function assertTextFrames(
  dir: string,
  video: string,
  format: Format,
  times: number[],
  expected: boolean[],
) {
  for (const [index, time] of times.entries()) {
    const frame = path.join(dir, `frame-${index}.webp`);
    await extractVideoFrame(video, time, format, frame);
    const pixels = await sharp(await readFile(frame))
      .raw()
      .toBuffer();
    assert.equal(
      pixels.some((channel) => channel > 100),
      expected[index],
      `frame at ${time} ms`,
    );
  }
}
