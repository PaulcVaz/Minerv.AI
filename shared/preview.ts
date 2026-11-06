import {
  active,
  clipSource,
  stale,
  timeline,
  segmentInterval,
  timelineDurationMs,
  type Project,
} from "./types.ts";
export type Visual =
  | {
      kind: "video";
      file: string;
      segmentId: string;
      generationId: string;
      originMs: number;
    }
  | { kind: "image"; file: string; clipId?: string }
  | { kind: "placeholder" };
export interface PreviewPart {
  startMs: number;
  endMs: number;
  visual: Visual;
}
export function previewPlan(
  p: Project,
  unavailable: ReadonlySet<string> = new Set(),
): PreviewPart[] {
  const segments = timeline(p);
  const duration = timelineDurationMs(p);
  const bounds = [
    ...new Set([
      0,
      duration,
      ...p.keyframes.filter((k) => k.timeMs <= duration).map((k) => k.timeMs),
      ...(p.videoClips ?? []).flatMap((c) => [c.startTimeMs, c.startTimeMs + c.durationMs]),
      ...p.staticImageClips.flatMap((c) => [
        c.startTimeMs,
        c.startTimeMs + c.durationMs,
      ]),
    ]),
  ].sort((a, b) => a - b);
  return bounds.slice(0, -1).map((startMs, i) => {
    const endMs = bounds[i + 1];
    const s = segments.find((s) => {
      const t = segmentInterval(p, s);
      return startMs >= t.startTimeMs && startMs < t.endTimeMs;
    });
    const g = s && active(s);
    const detached = p.videoClips?.find((clip) =>
      clip.startTimeMs <= startMs && startMs < clip.startTimeMs + clip.durationMs);
    const source = detached && clipSource(p, detached);
    let visual: Visual = { kind: "placeholder" };
    const clip = p.staticImageClips
      .filter(
        (c) =>
          startMs >= c.startTimeMs && startMs < c.startTimeMs + c.durationMs,
      )
      .sort((a, b) => b.startTimeMs - a.startTimeMs || a.id.localeCompare(b.id))
      .find((c) => {
        const file = p.media.find((m) => m.id === c.mediaId)?.image;
        return file && !unavailable.has(file);
      });
    const clipImage = clip && p.media.find((m) => m.id === clip.mediaId)?.image;
    const segmentIndex = s ? segments.indexOf(s) : -1;
    const left = segments[segmentIndex - 1], right = segments[segmentIndex + 1];
    const gap = !!(s?.detached || (s && !g && left && right && active(left) && active(right)));
    const anchorImage =
      s && !gap ?
      [s.start, s.end]
        .map((id) => p.keyframes.find((k) => k.id === id)?.image)
        .find((file) => file && !unavailable.has(file)) : undefined;
    if (detached && source?.file && !unavailable.has(source.file))
      visual = { kind: "video", file: source.file, segmentId: detached.id,
        generationId: source.id, originMs: detached.startTimeMs - detached.sourceStartMs };
    else if (g?.file && s && !stale(p, s) && !unavailable.has(g.file))
      visual = {
        kind: "video",
        file: g.file,
        segmentId: s.id,
        generationId: g.id,
        originMs: segmentInterval(p, s).startTimeMs,
      };
    else if (clipImage || anchorImage)
      visual = { kind: "image", file: (clipImage || anchorImage)!, ...(clipImage && clip ? { clipId: clip.id } : {}) };
    return { startMs, endMs, visual };
  });
}
export function keyframeTarget(p: Project, timeMs: number) {
  const t = Math.max(0, Math.round(timeMs));
  return p.keyframes.some((k) => k.timeMs === t)
    ? timelineDurationMs(p) + 4000
    : t;
}
