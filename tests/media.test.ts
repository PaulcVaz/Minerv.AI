import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { composeTimeline, run, trimVideoRange } from "../server/media.ts";
import type { Format } from "../shared/types.ts";

test("audio survives a clip split and a timeline with silent parts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "studio-audio-"));
  const format: Format = { ratio: "16:9", resolution: 720, fps: 24 };
  const source = path.join(dir, "source.mp4");
  const clip = path.join(dir, "trimmed.mp4");
  const silent = path.join(dir, "silent.mp4");
  const output = path.join(dir, "timeline.mp4");
  try {
    await run([
      "-f", "lavfi", "-i", "color=s=320x180:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-c:a", "aac", source,
    ]);
    await trimVideoRange(source, 500, 1000, format, clip);
    await run(["-i", clip, "-map", "0:a:0", "-f", "null", "-"]);
    await run(["-i", clip, "-an", "-c:v", "copy", silent]);
    await composeTimeline([
      { kind: "video", file: silent, durationMs: 1000 },
      { kind: "video", file: clip, durationMs: 1000 },
      { kind: "black", durationMs: 1000 },
    ], format, output);
    await run(["-i", output, "-map", "0:a:0", "-f", "null", "-"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
