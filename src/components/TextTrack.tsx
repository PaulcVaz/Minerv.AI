import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Type, Trash2 } from "lucide-react";
import {
  defaultText,
  textOverlaps,
  textPositions,
  type TextClip,
} from "../../shared/text";

export function useTextDrag(
  clips: readonly TextClip[],
  pixelsPerSecond: number,
  disabled: boolean,
  commit: (id: string, startTimeMs: number, durationMs: number) => void,
  onConflict: () => void,
) {
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    offset: number;
    clip?: TextClip;
    edge?: "left" | "right";
    moved: boolean;
  }>(undefined);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState<{
    start: number;
    duration: number;
    conflict: boolean;
  }>();
  const candidate = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    const rect = lane.current?.getBoundingClientRect();
    if (current?.clip && current.edge) {
      const { clip, edge } = current;
      const delta = Math.round(
        ((event.clientX - current.x) / pixelsPerSecond) * 1000,
      );
      const end = clip.startTimeMs + clip.durationMs;
      const previousEnd = Math.max(
        0,
        ...clips
          .filter(
            (item) =>
              item.id !== clip.id &&
              item.startTimeMs + item.durationMs <= clip.startTimeMs,
          )
          .map((item) => item.startTimeMs + item.durationMs),
      );
      const nextStart = Math.min(
        86_400_000,
        ...clips
          .filter((item) => item.id !== clip.id && item.startTimeMs >= end)
          .map((item) => item.startTimeMs),
      );
      const startTimeMs =
        edge === "left"
          ? Math.max(previousEnd, Math.min(end - 100, clip.startTimeMs + delta))
          : clip.startTimeMs;
      const endTimeMs =
        edge === "right"
          ? Math.min(nextStart, Math.max(clip.startTimeMs + 100, end + delta))
          : end;
      return { id: clip.id, startTimeMs, durationMs: endTimeMs - startTimeMs };
    }
    if (
      !current ||
      !rect ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom ||
      event.clientX < rect.left ||
      event.clientX >= rect.right
    )
      return;
    return {
      id: current.clip?.id ?? "",
      startTimeMs: Math.max(
        0,
        Math.round(
          ((event.clientX - rect.left - current.offset) / pixelsPerSecond) *
            1000,
        ),
      ),
      durationMs: current.clip?.durationMs ?? defaultText.durationMs,
    };
  };
  const reset = () => {
    drag.current = undefined;
    setGhost(undefined);
  };
  const bind = (
    click: () => void,
    clip?: TextClip,
    edge?: "left" | "right",
  ) => ({
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (!suppressClick.current || event.detail === 0) click();
      suppressClick.current = false;
    },
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      suppressClick.current = false;
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        clip,
        edge,
        offset: clip
          ? event.clientX - event.currentTarget.getBoundingClientRect().left
          : 0,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.moved ||=
        Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 5;
      if (!current.moved) return;
      suppressClick.current = true;
      const next = candidate(event);
      setGhost(
        next
          ? {
              start: next.startTimeMs,
              duration: next.durationMs,
              conflict: textOverlaps(clips, next),
            }
          : undefined,
      );
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      const moved =
        current.moved ||
        Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 5;
      const next = moved ? candidate(event) : undefined;
      reset();
      if (!moved) return;
      suppressClick.current = true;
      if (!next || disabled) return;
      if (textOverlaps(clips, next)) onConflict();
      else if (
        !current.clip ||
        next.startTimeMs !== current.clip.startTimeMs ||
        next.durationMs !== current.clip.durationMs
      )
        commit(next.id, next.startTimeMs, next.durationMs);
    },
    onPointerCancel: reset,
    onLostPointerCapture: reset,
  });
  return { lane, ghost, bind };
}

type TextDrag = ReturnType<typeof useTextDrag>;

export function AddTextCard({
  add,
  disabled,
  drag,
}: {
  add: () => void;
  disabled: boolean;
  drag: TextDrag;
}) {
  return (
    <button className="add-text-card" disabled={disabled} {...drag.bind(add)}>
      <Type size={16} /> Adicionar texto
    </button>
  );
}

export function TextTrack({
  clips,
  selectedId,
  pixelsPerSecond,
  drag,
  onSelect,
}: {
  clips: readonly TextClip[];
  selectedId: string | null;
  pixelsPerSecond: number;
  drag: TextDrag;
  onSelect: (id: string) => void;
}) {
  const { ghost } = drag;
  const px = (ms: number) => (ms / 1000) * pixelsPerSecond;
  return (
    <div
      ref={drag.lane}
      className={`text-lane${ghost?.conflict ? " conflict" : ""}`}
      aria-label="Faixa de texto"
    >
      {clips.map((clip) => (
        <div
          key={clip.id}
          className="text-clip-wrap"
          style={{ left: px(clip.startTimeMs), width: px(clip.durationMs) }}
        >
          <button
            className={`text-clip${selectedId === clip.id ? " selected" : ""}`}
            title={clip.content}
            aria-pressed={selectedId === clip.id}
            {...drag.bind(() => onSelect(clip.id), clip)}
          >
            <Type size={13} />
            <span>{clip.content}</span>
          </button>
          <button
            className="text-trim left"
            aria-label="Ajustar início do texto"
            title="Arraste para ajustar o início"
            {...drag.bind(() => onSelect(clip.id), clip, "left")}
          />
          <button
            className="text-trim right"
            aria-label="Ajustar fim do texto"
            title="Arraste para ajustar o fim"
            {...drag.bind(() => onSelect(clip.id), clip, "right")}
          />
        </div>
      ))}
      {ghost && (
        <span
          className={`text-ghost${ghost.conflict ? " conflict" : ""}`}
          style={{ left: px(ghost.start), width: px(ghost.duration) }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

const positionLabels = [
  "Topo à esquerda",
  "Topo ao centro",
  "Topo à direita",
  "Meio à esquerda",
  "Centro",
  "Meio à direita",
  "Base à esquerda",
  "Base ao centro",
  "Base à direita",
];

export function TextInspector({
  clip,
  clips,
  saving,
  save,
  remove,
}: {
  clip: TextClip;
  clips: readonly TextClip[];
  saving: boolean;
  save: (fields: Omit<TextClip, "id">) => Promise<boolean>;
  remove: () => void;
}) {
  const [draft, setDraft] = useState(clip);
  const [error, setError] = useState("");
  const edit = (fields: Partial<TextClip>) => {
    setDraft({ ...draft, ...fields });
    setError("");
  };
  return (
    <form
      className="inspector-content text-inspector"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.content.trim() || draft.content.split("\n").length > 8) {
          setError("Escreva um texto com até 8 linhas.");
          return;
        }
        if (textOverlaps(clips, draft)) {
          setError("Já existe texto neste intervalo.");
          return;
        }
        const { id, ...fields } = draft;
        void save(fields);
      }}
    >
      <label>
        Conteúdo
        <textarea
          required
          maxLength={500}
          rows={4}
          value={draft.content}
          onChange={(e) => edit({ content: e.target.value })}
        />
      </label>
      <div className="text-fields">
        <label>
          Início (ms)
          <input
            required
            type="number"
            min={0}
            max={86399900}
            step={1}
            value={draft.startTimeMs}
            onChange={(e) => edit({ startTimeMs: e.target.valueAsNumber || 0 })}
          />
        </label>
        <label>
          Duração (ms)
          <input
            required
            type="number"
            min={100}
            max={86400000 - draft.startTimeMs}
            step={1}
            value={draft.durationMs}
            onChange={(e) => edit({ durationMs: e.target.valueAsNumber || 0 })}
          />
        </label>
        <label>
          Tamanho
          <input
            required
            type="number"
            min={12}
            max={160}
            step={1}
            value={draft.size}
            onChange={(e) => edit({ size: e.target.valueAsNumber || 0 })}
          />
        </label>
        <label>
          Cor
          <input
            type="color"
            value={draft.color}
            onChange={(e) => edit({ color: e.target.value })}
          />
        </label>
      </div>
      <fieldset className="text-positions">
        <legend>Posição no quadro</legend>
        {textPositions.map((position, index) => (
          <button
            key={position}
            type="button"
            aria-label={positionLabels[index]}
            title={positionLabels[index]}
            aria-pressed={draft.position === position}
            onClick={() => edit({ position })}
          >
            ●
          </button>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="primary wide"
        disabled={saving || JSON.stringify(draft) === JSON.stringify(clip)}
      >
        Aplicar texto
      </button>
      <button
        type="button"
        className="wide danger"
        disabled={saving}
        onClick={remove}
      >
        <Trash2 size={14} /> Excluir texto
      </button>
    </form>
  );
}
