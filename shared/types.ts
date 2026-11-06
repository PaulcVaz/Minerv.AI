import type { TextClip } from "./text.ts";
import type { LayerTransform } from "./transform.ts";

export type Status = "Idle" | "Queued" | "Generating" | "Completed" | "Failed";
export function klingDurationSeconds(durationMs: number) {
  return durationMs >= 3000 && durationMs <= 15000
    ? Math.ceil(durationMs / 1000)
    : undefined;
}
export function seedanceDurationSeconds(durationMs: number) {
  return durationMs >= 4000 && durationMs <= 30000
    ? Math.ceil(durationMs / 1000)
    : undefined;
}
export const seedanceUsdPerSecond720p = 0.473;
export type Continuity = "Continuous" | "Neutral" | "Cut";
export interface Format {
  ratio: "16:9" | "9:16" | "1:1";
  resolution: 720 | 1080;
  fps: 24 | 25 | 30;
}
export interface Settings {
  prompt: string;
  continuity: Continuity;
  model: "Demo" | "Kling V3" | "Seedance 2.5";
  seed: string;
}
export interface Keyframe {
  id: string;
  name: string;
  image?: string | null;
  timeMs: number;
}
export interface MediaAsset {
  id: string;
  name: string;
  image: string;
}
export interface VideoAsset {
  id: string;
  name: string;
  file: string;
  firstImage: string;
  lastImage: string;
  durationMs: number;
  format: Format;
}
export interface Generation {
  importedVideoId?: string;
  inputImages?: [string | null, string | null];
  id: string;
  status: Status;
  settings: Settings;
  durationMs: number;
  format: Format;
  createdAt: string;
  file?: string;
  error?: string;
  derivedFromGenerationId?: string;
  actorImage?: string;
}
export interface StaticImageClip {
  id: string;
  mediaId: string;
  startTimeMs: number;
  durationMs: number;
}
export interface VideoClip {
  id: string;
  generationId: string;
  startTimeMs: number;
  durationMs: number;
  sourceStartMs: number;
}
export interface Segment {
  id: string;
  start: string;
  end: string;
  settings: Settings;
  generations: Generation[];
  activeId?: string;
  detached?: boolean;
}
export interface ExportJob {
  id: string;
  kind: "preview" | "export";
  signature: string;
  generationIds: string[];
  format: Format;
  status: Status;
  file?: string;
  error?: string;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  format: Format;
  media: MediaAsset[];
  videos?: VideoAsset[];
  keyframes: Keyframe[];
  staticImageClips: StaticImageClip[];
  videoClips?: VideoClip[];
  textClips?: TextClip[];
  layerTransforms?: Record<string, LayerTransform>;
  segments: Segment[];
  selectedId: string | null;
  jobs: ExportJob[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface PendingDeletion {
  id: string;
  projectId: string;
  projectName: string;
  createdAt: string;
}
export const defaultSettings = (): Settings => ({
  prompt: "",
  continuity: "Continuous",
  model: "Kling V3",
  seed: "",
});
export function timeline(p: Project): Segment[] {
  const keyframes = orderedKeyframes(p);
  return keyframes
    .slice(0, -1)
    .map((k, i) =>
      p.segments.find(
        (s) => s.start === k.id && s.end === keyframes[i + 1].id,
      )!,
    );
}
export function orderedKeyframes(p: Project) {
  return [...p.keyframes].sort(
    (a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id),
  );
}
export function segmentInterval(p: Project, s: Segment) {
  const start = p.keyframes.find((k) => k.id === s.start)!;
  const end = p.keyframes.find((k) => k.id === s.end)!;
  return { startTimeMs: start.timeMs, endTimeMs: end.timeMs };
}
export function segmentDurationMs(p: Project, s: Segment) {
  const interval = segmentInterval(p, s);
  return interval.endTimeMs - interval.startTimeMs;
}
export function active(s: Segment): Generation | undefined {
  if (s.detached) return undefined;
  return s.generations.find(
    (g) => g.id === s.activeId && g.status === "Completed",
  );
}
export function clipSource(p: Project, clip: VideoClip) {
  return p.segments.flatMap((segment) => segment.generations)
    .find((generation) => generation.id === clip.generationId && generation.status === "Completed" && generation.file);
}
export function stale(p: Project, s: Segment) {
  const g = active(s);
  if (g?.importedVideoId) return g.durationMs !== segmentDurationMs(p, s);
  return (
    !!g &&
    ((g.inputImages !== undefined &&
      JSON.stringify(g.inputImages) !== JSON.stringify(segmentImages(p, s))) ||
      JSON.stringify(g.settings) !== JSON.stringify(s.settings) ||
      g.durationMs !== segmentDurationMs(p, s) ||
      JSON.stringify(g.format) !== JSON.stringify(p.format))
  );
}
export function segmentImages(
  p: Project,
  s: Segment,
): [string | null, string | null] {
  return [
    p.keyframes.find((k) => k.id === s.start)?.image || null,
    p.keyframes.find((k) => k.id === s.end)?.image || null,
  ];
}
export function isImportedFrame(p: Project, image: unknown): image is string {
  return typeof image === "string" && !!p.videos?.some(
    (video) => video.firstImage === image || video.lastImage === image,
  );
}
export function editorStructure(p: Project) {
  return {
    keyframes: p.keyframes
      .map((k) => ({
        id: k.id,
        name: k.name,
        timeMs: k.timeMs,
        image: k.image || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    staticImageClips: p.staticImageClips
      .map((c) => ({
        id: c.id,
        mediaId: c.mediaId,
        startTimeMs: c.startTimeMs,
        durationMs: c.durationMs,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    textClips: [...(p.textClips ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    videoClips: [...(p.videoClips ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    detachedSegments: p.segments.filter((s) => s.detached).map((s) => s.id).sort(),
    layerTransforms: Object.fromEntries(Object.entries(p.layerTransforms ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    importedClips: timeline(p)
      .flatMap((s) => {
        const clip = active({ ...s, detached: false });
        return clip?.importedVideoId ? [{ segmentId: s.id, generationId: clip.id }] : [];
      })
      .sort((a, b) => a.segmentId.localeCompare(b.segmentId)),
  };
}
export type EditorStructure = ReturnType<typeof editorStructure>;
export function signature(p: Project) {
  return JSON.stringify([
    p.format,
    editorStructure(p).textClips,
    editorStructure(p).videoClips,
    editorStructure(p).detachedSegments,
    editorStructure(p).layerTransforms,
    orderedKeyframes(p).map((k) => [k.id, k.timeMs]),
    timeline(p).map((s) => s.activeId || ""),
    [...p.staticImageClips]
      .sort((a, b) => a.startTimeMs - b.startTimeMs || a.id.localeCompare(b.id))
      .map((c) => [c.id, c.mediaId, c.startTimeMs, c.durationMs]),
  ]);
}
export interface TimelineConflict {
  startTimeMs: number;
  endTimeMs: number;
  itemIds: [string, string];
}
export function timelineConflicts(p: Project): TimelineConflict[] {
  const items = [
    ...(p.videoClips ?? []).map((clip) => ({
      id: clip.id,
      startTimeMs: clip.startTimeMs,
      endTimeMs: clip.startTimeMs + clip.durationMs,
      kind: "independent" as const,
    })),
    ...p.staticImageClips.map((clip) => ({
      id: clip.id,
      startTimeMs: clip.startTimeMs,
      endTimeMs: clip.startTimeMs + clip.durationMs,
      kind: "static" as const,
    })),
    ...timeline(p)
      .filter((segment) => !!active(segment))
      .map((segment) => ({
        id: segment.id,
        ...segmentInterval(p, segment),
        kind: "generated" as const,
      })),
  ];
  const conflicts: TimelineConflict[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].kind === "generated" && items[j].kind === "generated")
        continue;
      const startTimeMs = Math.max(items[i].startTimeMs, items[j].startTimeMs);
      const endTimeMs = Math.min(items[i].endTimeMs, items[j].endTimeMs);
      if (startTimeMs < endTimeMs)
        conflicts.push({
          startTimeMs,
          endTimeMs,
          itemIds: [items[i].id, items[j].id],
        });
    }
  return conflicts;
}
export function timelineDurationMs(p: Project) {
  const detachedBoundaries = new Set<string>();
  for (const segment of p.segments)
    if (segment.detached) {
      detachedBoundaries.add(segment.start);
      detachedBoundaries.add(segment.end);
    }
  if (detachedBoundaries.size)
    for (const segment of timeline(p))
      if (active(segment)) {
        detachedBoundaries.delete(segment.start);
        detachedBoundaries.delete(segment.end);
      }
  return Math.max(
    0,
    ...p.keyframes.filter((k) => !detachedBoundaries.has(k.id)).map((k) => k.timeMs),
    ...p.staticImageClips.map((c) => c.startTimeMs + c.durationMs),
    ...(p.videoClips ?? []).map((c) => c.startTimeMs + c.durationMs),
    ...(p.textClips ?? []).map((c) => c.startTimeMs + c.durationMs),
  );
}
export function pendingSegments(p: Project) {
  return timeline(p).filter((s) => !s.detached && !active(s));
}
export function videoPlacementError(p: Project, video: VideoAsset, startTimeMs: number) {
  const endTimeMs = startTimeMs + video.durationMs;
  const overlaps = (start: number, end: number) => start < endTimeMs && end > startTimeMs;
  const segments = timeline(p);
  if (
    p.keyframes.some((k) => k.timeMs > startTimeMs && k.timeMs < endTimeMs) ||
    p.staticImageClips.some((c) => overlaps(c.startTimeMs, c.startTimeMs + c.durationMs)) ||
    p.videoClips?.some((c) => overlaps(c.startTimeMs, c.startTimeMs + c.durationMs)) ||
    segments.some((s) => {
      const interval = segmentInterval(p, s);
      return overlaps(interval.startTimeMs, interval.endTimeMs) &&
        (active(s) || s.generations.some((g) => g.status === "Queued" || g.status === "Generating"));
    })
  ) return "Escolha um trecho livre, sem clipes ou keyframes no interior do intervalo.";
  for (const [timeMs, image] of [[startTimeMs, video.firstImage], [endTimeMs, video.lastImage]] as const) {
    const keyframe = p.keyframes.find((k) => k.timeMs === timeMs);
    if (keyframe && keyframe.image !== image &&
        segments.some((s) => (s.start === keyframe.id || s.end === keyframe.id) && active(s)?.importedVideoId))
      return "Esta borda já pertence a outro vídeo importado.";
  }
  return "";
}
export function generatedChain(p: Project, segmentId: string) {
  const segments = timeline(p);
  const index = segments.findIndex((s) => s.id === segmentId && !!active(s));
  if (index < 0)
    return { segments: [] as Segment[], keyframes: [] as Keyframe[] };
  let first = index,
    last = index;
  while (first > 0 && active(segments[first - 1])) first--;
  while (last < segments.length - 1 && active(segments[last + 1])) last++;
  const chain = segments.slice(first, last + 1);
  const ids = [chain[0].start, ...chain.map((s) => s.end)];
  return {
    segments: chain,
    keyframes: ids.map((id) => p.keyframes.find((k) => k.id === id)!),
  };
}
export function withTimelinePositions(
  p: Project,
  keyframeTimes: Record<string, number> = {},
  staticClipTimes: Record<string, number> = {},
  videoClipTimes: Record<string, number> = {},
): Project {
  const project = structuredClone(p);
  for (const keyframe of project.keyframes)
    if (keyframeTimes[keyframe.id] !== undefined)
      keyframe.timeMs = keyframeTimes[keyframe.id];
  for (const clip of project.staticImageClips)
    if (staticClipTimes[clip.id] !== undefined)
      clip.startTimeMs = staticClipTimes[clip.id];
  for (const clip of project.videoClips ?? [])
    if (videoClipTimes[clip.id] !== undefined)
      clip.startTimeMs = videoClipTimes[clip.id];
  const keys = orderedKeyframes(project);
  for (let i = 0; i < keys.length - 1; i++)
    if (
      !project.segments.some(
        (s) => s.start === keys[i].id && s.end === keys[i + 1].id,
      )
    )
      project.segments.push({
        id: `preview:${keys[i].id}:${keys[i + 1].id}`,
        start: keys[i].id,
        end: keys[i + 1].id,
        settings: defaultSettings(),
        generations: [],
      });
  return project;
}
export function dimensions(f: Format): [number, number] {
  return f.ratio === "16:9"
    ? [(f.resolution * 16) / 9, f.resolution]
    : f.ratio === "9:16"
      ? [f.resolution, (f.resolution * 16) / 9]
      : [f.resolution, f.resolution];
}
