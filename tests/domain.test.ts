import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProject,
  id,
  reconcile,
  recover,
  splitGeneratedSegment,
} from "../server/domain.ts";
import {
  active,
  generatedChain,
  segmentDurationMs,
  signature,
  stale,
  timeline,
  timelineConflicts,
  timelineDurationMs,
  withTimelinePositions,
} from "../shared/types.ts";

const frame = (timeMs: number, name = String(timeMs)) => ({
  id: id(),
  name,
  image: `${name}.webp`,
  timeMs,
});

test("keyframes are temporal points and segment history follows ordered pair identity", () => {
  const p = createProject("test");
  const a = frame(0, "a"),
    b = frame(5000, "b"),
    c = frame(9000, "c");
  p.keyframes = [c, a, b];
  reconcile(p);
  assert.deepEqual(
    p.keyframes.map((k) => k.id),
    [a.id, b.id, c.id],
  );
  assert.equal(segmentDurationMs(p, timeline(p)[0]), 5000);
  const original = timeline(p)[0];
  original.settings.prompt = "keep this";
  p.keyframes = [a, c, b];
  b.timeMs = 12000;
  reconcile(p);
  assert.notEqual(timeline(p)[0].id, original.id);
  b.timeMs = 5000;
  reconcile(p);
  assert.equal(timeline(p)[0], original);
});

test("overlap detection uses half-open intervals and only active generated content", () => {
  const p = createProject("conflicts");
  p.media = [{ id: "media-a", name: "a", image: "a.webp" }];
  p.keyframes = [frame(0), frame(8000)];
  p.staticImageClips = [
    { id: "touching", mediaId: "media-a", startTimeMs: 8000, durationMs: 1000 },
    {
      id: "overlap-a",
      mediaId: "media-a",
      startTimeMs: 2000,
      durationMs: 3000,
    },
    {
      id: "overlap-b",
      mediaId: "media-a",
      startTimeMs: 4000,
      durationMs: 3000,
    },
  ];
  reconcile(p);
  assert.deepEqual(
    timelineConflicts(p).map((c) => [c.startTimeMs, c.endTimeMs]),
    [[4000, 5000]],
  );
  const s = timeline(p)[0];
  s.generations.push({
    id: "active",
    status: "Completed",
    settings: { ...s.settings },
    durationMs: 8000,
    format: { ...p.format },
    createdAt: "now",
  });
  s.activeId = "active";
  assert.ok(timelineConflicts(p).some((c) => c.itemIds.includes(s.id)));
  assert.equal(timelineDurationMs(p), 9000);
});

test("generation duration participates in stale state and cache identity", () => {
  const p = createProject("cache");
  p.keyframes = [frame(0), frame(4000)];
  reconcile(p);
  const s = timeline(p)[0];
  s.generations.push({
    id: "v1",
    status: "Completed",
    settings: { ...s.settings },
    durationMs: 4000,
    format: { ...p.format },
    createdAt: "now",
  });
  s.activeId = "v1";
  assert.equal(active(s)?.id, "v1");
  assert.equal(stale(p, s), false);
  const old = signature(p);
  p.keyframes[1].timeMs = 5000;
  assert.equal(stale(p, s), true);
  assert.notEqual(signature(p), old);
});

test("interrupted work becomes retryable", () => {
  const p = createProject("recover");
  p.jobs.push({
    id: id(),
    kind: "export",
    signature: "test",
    generationIds: [],
    format: p.format,
    status: "Generating",
    createdAt: "now",
  });
  assert.equal(recover(p), true);
  assert.equal(p.jobs[0].status, "Failed");
});

test("generated chains stop at segments without an active version", () => {
  const p = createProject("chains");
  p.keyframes = [frame(0), frame(4000), frame(8000), frame(12000)];
  reconcile(p);
  const segments = timeline(p);
  for (const [index, segment] of segments.entries())
    if (index !== 1) {
      segment.generations.push({
        id: `active-${index}`,
        status: "Completed",
        settings: { ...segment.settings },
        durationMs: 4000,
        format: { ...p.format },
        createdAt: "now",
      });
      segment.activeId = `active-${index}`;
    }
  assert.deepEqual(
    generatedChain(p, segments[0].id).keyframes.map((k) => k.timeMs),
    [0, 4000],
  );
  assert.deepEqual(
    generatedChain(p, segments[2].id).keyframes.map((k) => k.timeMs),
    [8000, 12000],
  );
  const moved = withTimelinePositions(p, {
    [p.keyframes[0].id]: 2000,
    [p.keyframes[1].id]: 6000,
  });
  assert.equal(segmentDurationMs(moved, timeline(moved)[0]), 4000);
});

test("splitting a generated segment preserves history and activates both derived versions", () => {
  const p = createProject("split");
  p.keyframes = [frame(0, "start"), frame(8000, "end")];
  reconcile(p);
  const original = timeline(p)[0];
  original.settings.prompt = "preserved prompt";
  original.generations.push({
    id: "source-generation",
    status: "Completed",
    settings: { ...original.settings },
    durationMs: 8000,
    format: { ...p.format },
    createdAt: "now",
    file: "source.mp4",
  });
  original.activeId = "source-generation";
  const result = splitGeneratedSegment(p, original.id, 3000, {
    frame: "frame.webp",
    leftVideo: "left.mp4",
    rightVideo: "right.mp4",
  });
  const current = timeline(result.project);
  assert.deepEqual(
    current.map((segment) => segmentDurationMs(result.project, segment)),
    [3000, 5000],
  );
  assert.ok(
    result.project.segments.some((segment) => segment.id === original.id),
  );
  assert.equal(result.project.selectedId, result.keyframeId);
  assert.equal(result.project.media.at(-1)?.image, "frame.webp");
  for (const segment of current) {
    assert.equal(segment.settings.prompt, "preserved prompt");
    assert.equal(active(segment)?.status, "Completed");
    assert.equal(active(segment)?.derivedFromGenerationId, "source-generation");
  }
  assert.throws(
    () =>
      splitGeneratedSegment(p, original.id, 0, {
        frame: "x",
        leftVideo: "y",
        rightVideo: "z",
      }),
    /inside the segment/,
  );
  p.keyframes[1].timeMs = 9000;
  assert.throws(
    () =>
      splitGeneratedSegment(p, original.id, 3000, {
        frame: "x",
        leftVideo: "y",
        rightVideo: "z",
      }),
    /Regenerate this segment/,
  );
});
