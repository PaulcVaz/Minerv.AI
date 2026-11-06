import { randomUUID } from "node:crypto";
import {
  active,
  defaultSettings,
  segmentDurationMs,
  stale,
  segmentImages,
  timeline,
  type Project,
} from "../shared/types.ts";
export const id = randomUUID;
export function createProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: id(),
    name,
    format: { ratio: "16:9", resolution: 1080, fps: 30 },
    media: [],
    keyframes: [],
    staticImageClips: [],
    textClips: [],
    segments: [],
    selectedId: null,
    jobs: [],
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}
export function reconcile(p: Project) {
  p.keyframes.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  for (let i = 0; i < p.keyframes.length - 1; i++) {
    const start = p.keyframes[i].id,
      end = p.keyframes[i + 1].id;
    if (!p.segments.some((s) => s.start === start && s.end === end))
      p.segments.push({
        id: id(),
        start,
        end,
        settings: defaultSettings(),
        generations: [],
      });
  }
  const ids = new Set(p.keyframes.map((k) => k.id));
  if (
    p.selectedId &&
    !ids.has(p.selectedId) &&
    !p.staticImageClips.some((c) => c.id === p.selectedId) &&
    !p.videoClips?.some((c) => c.id === p.selectedId) &&
    !p.textClips?.some((c) => c.id === p.selectedId) &&
    !p.segments.some(
      (s) =>
        s.id === p.selectedId &&
        p.keyframes.some(
          (k, i) => k.id === s.start && p.keyframes[i + 1]?.id === s.end,
        ),
    )
  )
    p.selectedId = null;
}

export function splitGeneratedSegment(
  source: Project,
  segmentId: string,
  timeMs: number,
  files: { frame: string; leftVideo: string; rightVideo: string },
) {
  const p = structuredClone(source);
  const original = timeline(p).find((segment) => segment.id === segmentId);
  if (!original) throw new Error("Select a current segment.");
  const generation = active(original);
  if (!generation?.file) throw new Error("Generate this segment first.");
  if (stale(p, original))
    throw new Error(
      "Regenerate this segment before creating a keyframe from its video.",
    );
  const start = p.keyframes.find((keyframe) => keyframe.id === original.start)!;
  const end = p.keyframes.find((keyframe) => keyframe.id === original.end)!;
  if (
    !Number.isInteger(timeMs) ||
    timeMs <= start.timeMs ||
    timeMs >= end.timeMs
  )
    throw new Error("Choose a timestamp inside the segment.");
  if (p.keyframes.some((keyframe) => keyframe.timeMs === timeMs))
    throw new Error("A keyframe already exists at this timestamp.");

  const mediaId = id();
  const keyframeId = id();
  const label = `${(timeMs / 1000).toFixed(3)}s`;
  p.media.push({
    id: mediaId,
    name: `Extracted frame ${label}`,
    image: files.frame,
  });
  p.keyframes.push({
    id: keyframeId,
    name: `Keyframe ${label}`,
    image: files.frame,
    timeMs,
  });
  reconcile(p);
  const left = p.segments.find(
    (segment) => segment.start === start.id && segment.end === keyframeId,
  )!;
  const right = p.segments.find(
    (segment) => segment.start === keyframeId && segment.end === end.id,
  )!;
  const createdAt = new Date().toISOString();
  for (const [segment, file] of [
    [left, files.leftVideo],
    [right, files.rightVideo],
  ] as const) {
    segment.settings = structuredClone(original.settings);
    const derived = {
      id: id(),
      status: "Completed" as const,
      settings: structuredClone(generation.settings),
      durationMs: segmentDurationMs(p, segment),
      format: structuredClone(generation.format),
      createdAt,
      file,
      derivedFromGenerationId: generation.id,
      importedVideoId: generation.importedVideoId,
      inputImages: segmentImages(p, segment),
    };
    segment.generations.push(derived);
    segment.activeId = derived.id;
  }
  p.selectedId = keyframeId;
  return {
    project: p,
    keyframeId,
    leftSegmentId: left.id,
    rightSegmentId: right.id,
  };
}
export function recover(p: Project) {
  let changed = false;
  for (const job of [...p.jobs, ...p.segments.flatMap((s) => s.generations)])
    if (job.status === "Queued" || job.status === "Generating") {
      job.status = "Failed";
      job.error = "The server stopped before this job finished. Please retry.";
      changed = true;
    }
  return changed;
}
