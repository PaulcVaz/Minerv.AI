import { useRef, useState, type PointerEvent } from "react";
import {
  identityTransform,
  maxLayerScale,
  minLayerScale,
  type LayerTransform,
} from "../../shared/transform";

export interface PreviewLayer {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  transform?: LayerTransform;
}
type Gesture = "move" | "scale" | "rotate";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const angle = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;
const center = ({ bounds: b }: PreviewLayer) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

export function usePreviewTransform(
  width: number,
  height: number,
  disabled: boolean,
  pause: () => void,
  select: (id: string) => void,
  save: (id: string, transform: LayerTransform) => Promise<boolean>,
) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    pointer: number;
    layer: PreviewLayer;
    mode: Gesture;
    x: number;
    y: number;
    transform: LayerTransform;
    moved: boolean;
    token: symbol;
  }>(undefined);
  const [draft, setDraft] = useState<{
    id: string;
    transform: LayerTransform;
    token: symbol;
  }>();
  const point = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    return (
      matrix &&
      new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse(),
      )
    );
  };
  const start = (event: PointerEvent, layer: PreviewLayer, mode: Gesture) => {
    if (disabled || drag.current || event.button !== 0 || !event.isPrimary)
      return;
    const p = point(event);
    if (!p) return;
    event.preventDefault();
    pause();
    const transform = layer.transform ?? identityTransform;
    const token = Symbol();
    drag.current = {
      pointer: event.pointerId,
      layer,
      mode,
      x: p.x,
      y: p.y,
      transform,
      moved: false,
      token,
    };
    setDraft({ id: layer.id, transform, token });
    svg.current?.setPointerCapture(event.pointerId);
  };
  const next = (event: PointerEvent) => {
    const state = drag.current;
    const p = point(event);
    if (!state || state.pointer !== event.pointerId || !p) return;
    const { layer, mode, x, y, transform: t } = state;
    state.moved ||= Math.hypot((p.x - x) / width, (p.y - y) / height) > 0.002;
    if (!state.moved) return t;
    const c = center(layer);
    const cx = c.x + t.x * width,
      cy = c.y + t.y * height;
    if (mode === "move")
      return {
        ...t,
        x: clamp(
          t.x + (p.x - x) / width,
          0.02 - c.x / width,
          0.98 - c.x / width,
        ),
        y: clamp(
          t.y + (p.y - y) / height,
          0.02 - c.y / height,
          0.98 - c.y / height,
        ),
      };
    if (mode === "scale")
      return {
        ...t,
        scale: clamp(
          (t.scale * Math.hypot(p.x - cx, p.y - cy)) /
            Math.max(1, Math.hypot(x - cx, y - cy)),
          minLayerScale,
          maxLayerScale,
        ),
      };
    const rotation =
      t.rotation + angle(p.x - cx, p.y - cy) - angle(x - cx, y - cy);
    return { ...t, rotation: (((rotation % 360) + 540) % 360) - 180 };
  };
  const cancel = (event: PointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    setDraft(undefined);
  };
  return {
    draft,
    svg,
    start,
    move: (event: PointerEvent) => {
      const transform = next(event),
        state = drag.current;
      if (transform && state)
        setDraft({ id: state.layer.id, transform, token: state.token });
    },
    end: async (event: PointerEvent) => {
      const state = drag.current;
      if (!state || state.pointer !== event.pointerId) return;
      const transform = next(event);
      drag.current = undefined;
      try {
        if (state.moved && transform) await save(state.layer.id, transform);
        else select(state.layer.id);
      } finally {
        setDraft((value) => (value?.token === state.token ? undefined : value));
      }
    },
    cancel,
  };
}

export function PreviewTransform({
  width,
  height,
  layers,
  selectedId,
  controls,
}: {
  width: number;
  height: number;
  layers: PreviewLayer[];
  selectedId: string | null;
  controls: ReturnType<typeof usePreviewTransform>;
}) {
  return (
    <svg
      className="preview-transform"
      ref={controls.svg}
      viewBox={`0 0 ${width} ${height}`}
      onPointerMove={controls.move}
      onPointerUp={controls.end}
      onPointerCancel={controls.cancel}
      onLostPointerCapture={controls.cancel}
    >
      {layers.map((layer) => {
        const b = layer.bounds;
        const { x, y } = center(layer);
        const t =
          controls.draft?.id === layer.id
            ? controls.draft.transform
            : (layer.transform ?? identityTransform);
        const selected = (controls.draft?.id ?? selectedId) === layer.id;
        const inset = Math.min(b.width, b.height) * 0.1;
        const radius = (Math.min(width, height) * 0.012) / t.scale;
        return (
          <g
            key={layer.id}
            transform={`translate(${x + t.x * width} ${y + t.y * height}) rotate(${t.rotation}) scale(${t.scale}) translate(${-x} ${-y})`}
          >
            <rect
              className={`preview-hit${selected ? " selected" : ""}`}
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              aria-label={layer.label}
              onPointerDown={(event) => controls.start(event, layer, "move")}
            />
            {selected && (
              <>
                <circle
                  className="preview-handle scale"
                  aria-label="Redimensionar"
                  cx={b.x + b.width - inset}
                  cy={b.y + b.height - inset}
                  r={radius}
                  onPointerDown={(event) =>
                    controls.start(event, layer, "scale")
                  }
                >
                  <title>Redimensionar</title>
                </circle>
                <circle
                  className="preview-handle rotate"
                  aria-label="Girar"
                  cx={x}
                  cy={b.y + inset}
                  r={radius}
                  onPointerDown={(event) =>
                    controls.start(event, layer, "rotate")
                  }
                >
                  <title>Girar</title>
                </circle>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
