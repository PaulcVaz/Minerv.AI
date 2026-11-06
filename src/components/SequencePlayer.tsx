import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { previewPlan, type Visual } from "../../shared/preview";
import { dimensions, timeline, type Project } from "../../shared/types";
import { textAt, textLayout, textSvg } from "../../shared/text";
import type { LayerTransform } from "../../shared/transform";
import { PreviewTransform, usePreviewTransform, type PreviewLayer } from "./PreviewTransform";
export function SequencePlayer({
  project,
  position,
  playing,
  volume,
  onPosition,
  onPlaying,
  onFrame,
  editingDisabled,
  onSelectLayer,
  onTransformLayer,
}: {
  project: Project;
  position: number;
  playing: boolean;
  volume: number;
  onPosition: (value: number) => void;
  onPlaying: (value: boolean) => void;
  onFrame: (value: { segmentId: string; timeMs: number } | null) => void;
  editingDisabled: boolean;
  onSelectLayer: (id: string) => void;
  onTransformLayer: (id: string, transform: LayerTransform) => Promise<boolean>;
}) {
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef({ position, playing, onPosition, onPlaying });
  current.current = { position, playing, onPosition, onPlaying };
  const identity = JSON.stringify([
    project.format,
    project.keyframes,
    project.staticImageClips,
    project.videoClips,
    project.textClips,
    project.media,
    timeline(project).map((s) => [
      s.settings,
      s.activeId,
      s.detached,
      s.generations.filter((g) => g.id === s.activeId),
    ]),
  ]);
  const plan = useMemo(
    () => previewPlan(project, unavailable),
    [identity, unavailable],
  );
  const duration = plan.at(-1)?.endMs || 0;
  const positionMs = Math.floor(position * 1000 + 0.000001);
  const part =
    plan.find(
      (p) => positionMs >= p.startMs && positionMs < p.endMs,
    ) || (positionMs === duration ? plan.at(-1) : undefined);
  const visual: Visual = part?.visual || { kind: "placeholder" };
  const overlay = textAt(project.textClips ?? [], positionMs);
  const [width, height] = dimensions(project.format);
  const mediaId = visual.kind === "video" ? visual.segmentId : visual.kind === "image" ? visual.clipId : undefined;
  const layers: PreviewLayer[] = [];
  if (mediaId) layers.push({ id: mediaId, label: "Mover mídia", bounds: { x: 0, y: 0, width, height }, transform: project.layerTransforms?.[mediaId] });
  if (overlay) layers.push({ id: overlay.id, label: "Mover texto", bounds: textLayout(overlay, project.format).bounds, transform: project.layerTransforms?.[overlay.id] });
  const controls = usePreviewTransform(width, height, editingDisabled, () => onPlaying(false), onSelectLayer, onTransformLayer);
  const transform = (id: string | undefined) => id
    ? (controls.draft?.id === id ? controls.draft.transform : project.layerTransforms?.[id])
    : undefined;
  const textTransform = transform(overlay?.id);
  const mediaTransform = transform(mediaId);
  const mediaStyle = mediaTransform ? { transform:
    `translate(${mediaTransform.x * 100}%, ${mediaTransform.y * 100}%) rotate(${mediaTransform.rotation}deg) scale(${mediaTransform.scale})`,
  } : undefined;
  const overlayUrl = useMemo(() => overlay
    ? "data:image/svg+xml," + encodeURIComponent(textSvg(overlay, project.format, textTransform))
    : undefined, [overlay, project.format, textTransform]);
  const file = visual.kind !== "placeholder" ? visual.file : "";
  useLayoutEffect(() => {
    if (video.current) video.current.volume = volume;
  }, [visual.kind, file, volume]);
  const report = () => {
    const v = video.current;
    onFrame(
      visual.kind === "video" &&
        v &&
        v.readyState >= 2 &&
        !v.seeking &&
        Math.abs(v.currentTime - (position - visual.originMs / 1000)) <
          1 / project.format.fps
        ? { segmentId: visual.segmentId, timeMs: Math.round(position * 1000) }
        : null,
    );
  };
  useEffect(() => {
    onPlaying(false);
    onPosition(Math.min(current.current.position, duration / 1000));
  }, [identity]);
  useEffect(() => {
    report();
    return () => onFrame(null);
  }, [file, position]);
  useEffect(() => {
    if (visual.kind !== "video" || !video.current) return;
    const v = video.current,
      desired = Math.max(0, position - visual.originMs / 1000);
    if (Math.abs(v.currentTime - desired) > (playing ? 0.12 : 0.001)) {
      onFrame(null);
      v.currentTime = desired;
    }
    if (playing) void v.play().catch(() => onPlaying(false));
    else v.pause();
  }, [file, visual.kind === "video" ? visual.originMs : null, playing, position]);
  useEffect(() => {
    if (!playing || !part) return;
    let frame = 0,
      previous = performance.now();
    const tick = (now: number) => {
      const state = current.current;
      let next = state.position;
      if (visual.kind === "video") {
        const v = video.current;
        if (v && !v.seeking && v.readyState >= 2)
          next = v.currentTime + visual.originMs / 1000;
        if (v?.ended) next = part.endMs / 1000;
      } else next += (now - previous) / 1000;
      previous = now;
      next = Math.min(next, part.endMs / 1000);
      state.onPosition(next);
      if (next >= duration / 1000) state.onPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, part?.startMs, part?.endMs, file]);
  const failed = () => {
    onFrame(null);
    setUnavailable((old) => new Set([...old, file]));
  };
  return (
    <div className="sequence-canvas" style={{ "--canvas-ratio": width / height } as React.CSSProperties}>
      {visual.kind === "video" ? (
        <video
          key={visual.segmentId + ":" + file}
          ref={video}
          style={mediaStyle}
          src={"/media/" + file}
          playsInline
          onError={failed}
          onLoadedMetadata={() => {
            if (video.current)
              video.current.currentTime = Math.max(
                0,
                position - visual.originMs / 1000,
              );
            if (playing)
              void video.current?.play().catch(() => onPlaying(false));
          }}
          onLoadedData={report}
          onSeeked={report}
          onSeeking={() => onFrame(null)}
        />
      ) : visual.kind === "image" ? (
        <img src={"/media/" + file} style={mediaStyle} onError={failed} alt="Imagem da timeline" draggable={false} />
      ) : project.textClips?.length || project.videoClips?.length || project.segments.some((segment) => segment.activeId) ? (
        <div className="preview-black" />
      ) : (
        <div className="preview-empty">
          <span>Seu vídeo começa com uma imagem</span>
        </div>
      )}
      {overlayUrl && <img className="preview-text-overlay" src={overlayUrl} alt={overlay?.content} draggable={false} />}
      {layers.length > 0 && <PreviewTransform width={width} height={height}
        layers={layers} selectedId={project.selectedId} controls={controls} />}
      {unavailable.size > 0 && (
        <div className="preview-notice">
          Algumas mídias não carregaram. Exibindo a alternativa disponível.
        </div>
      )}
    </div>
  );
}
