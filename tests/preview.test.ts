import { test } from "node:test";
import assert from "node:assert/strict";
import { createProject, reconcile, id } from "../server/domain.ts";
import { active, segmentImages, stale, timeline } from "../shared/types.ts";
import { previewPlan, keyframeTarget } from "../shared/preview.ts";

test("incomplete preview resolves video, static, either anchor and missing media without generating", () => {
  const p = createProject("Preview");
  p.keyframes = [
    { id: "a", name: "A", timeMs: 0, image: "a.webp" },
    { id: "b", name: "B", timeMs: 1000 },
    { id: "c", name: "C", timeMs: 2000, image: "c.webp" },
  ];
  reconcile(p);
  assert.deepEqual(
    previewPlan(p).map((x) => x.visual),
    [
      { kind: "image", file: "a.webp" },
      { kind: "image", file: "c.webp" },
    ],
  );
  assert.deepEqual(
    previewPlan(p, new Set(["a.webp", "c.webp"])).map((x) => x.visual.kind),
    ["placeholder", "placeholder"],
  );
  const s = timeline(p)[0];
  s.generations.push({
    id: id(),
    status: "Completed",
    settings: { ...s.settings },
    durationMs: 1000,
    format: { ...p.format },
    createdAt: "now",
    file: "video.mp4",
    inputImages: segmentImages(p, s),
  });
  s.activeId = s.generations[0].id;
  p.media.push({ id: "m", name: "Static", image: "static.webp" });
  p.staticImageClips.push({
    id: "clip",
    mediaId: "m",
    startTimeMs: 500,
    durationMs: 1000,
  });
  assert.deepEqual(
    previewPlan(p).map((x) => x.visual.kind),
    ["video", "video", "image", "image"],
  );
  assert.equal(
    previewPlan(p)[2].visual.kind === "image" &&
      (previewPlan(p)[2].visual as any).file,
    "static.webp",
  );
  p.keyframes[0].image = undefined;
  assert.equal(stale(p, s), true);
  assert.deepEqual(
    previewPlan(p).map((x) => x.visual.kind),
    ["placeholder", "image", "image", "image"],
  );
  p.keyframes[0].image = "a.webp";
  assert.equal(stale(p, s), false);
  assert.equal(active(s)?.file, "video.mp4");
  assert.equal(p.jobs.length, 0);
  assert.equal(keyframeTarget(p, 0), 6000);
  assert.equal(keyframeTarget(p, 700), 700);
});
test("empty preview, gaps and deterministic static overlap", () => {
  const p = createProject("Empty");
  assert.deepEqual(previewPlan(p), []);
  p.media = [
    { id: "a", name: "A", image: "a.webp" },
    { id: "b", name: "B", image: "b.webp" },
  ];
  p.staticImageClips = [
    { id: "z", mediaId: "a", startTimeMs: 1000, durationMs: 3000 },
    { id: "a", mediaId: "b", startTimeMs: 2000, durationMs: 1000 },
  ];
  assert.deepEqual(
    previewPlan(p).map((x) => x.visual),
    [
      { kind: "placeholder" },
      { kind: "image", file: "a.webp", clipId: "z" },
      { kind: "image", file: "b.webp", clipId: "a" },
      { kind: "image", file: "a.webp", clipId: "z" },
    ],
  );
});
