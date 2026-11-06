import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Film,
  Plus,
  Upload,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  Copy,
  Trash2,
  Play,
  Pause,
  SkipBack,
  Volume2,
  VolumeX,
  Maximize,
  Download,
  Sparkles,
  Check,
  Image as ImageIcon,
  SlidersHorizontal,
  Scissors,
  Link,
  Minus,
  X,
  LoaderCircle,
  Clock3,
  RefreshCw,
  Search,
  Grid2X2,
  List,
  CheckSquare2,
  House,
  ArrowUpRight,
} from "lucide-react";
import { Brand } from "./components/Brand";
import { CreateProjectDialog } from "./components/CreateProjectDialog";
import { FalSettingsDialog } from "./components/FalSettingsDialog";
import { useStudio, api, type Summary } from "./store";
import {
  active,
  generatedChain,
  isImportedFrame,
  klingDurationSeconds,
  orderedKeyframes,
  pendingSegments,
  segmentImages,
  segmentDurationMs,
  segmentInterval,
  timeline,
  timelineConflicts,
  timelineDurationMs,
  videoPlacementError,
  withTimelinePositions,
  stale,
  type Project,
  type Segment,
  type Settings,
  type Format,
  type MediaAsset,
  type PendingDeletion,
  type StaticImageClip,
  type VideoAsset,
} from "../shared/types";
import "./styles.css";
import "./minerv.css";
import { SequencePlayer } from "./components/SequencePlayer";
import { AddTextCard, TextInspector, TextTrack, useTextDrag } from "./components/TextTrack";
import { defaultText, textOverlaps } from "../shared/text";
import { keyframeTarget } from "../shared/preview";
import { label, localError } from "./labels";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ActionToast } from "./components/ActionToast";
const media = (file?: string | null) => (file ? "/media/" + file : undefined);
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${(n % 60).toFixed(1).padStart(4, "0")}`;
const pointerTimeMs = (clientX: number, element: HTMLElement, zoom: number) =>
  Math.max(
    0,
    Math.round(
      ((clientX - element.getBoundingClientRect().left) / (55 * zoom)) * 1000,
    ),
  );
const UNDO_DURATION = 3000;
type TimelineMove =
  | { kind: "keyframe"; id: string; grabOffsetMs: number; timeMs: number }
  | ({
      id: string;
      grabOffsetMs: number;
      startTimeMs: number;
    } & ({ kind: "staticClip" } | { kind: "videoClip" }))
  | {
      kind: "generatedChain";
      segmentId: string;
      grabOffsetMs: number;
      deltaMs: number;
      keyframeIds: string[];
    };
type TimelineContextMenu = {
  kind: "segment" | "staticClip" | "videoClip";
  itemId: string;
  clientX: number;
  clientY: number;
};
type Route = { screen: "home" } | { screen: "studio"; projectId: string };
interface DeletionBatch {
  id: string;
  items: PendingDeletion[];
}
const deletionGroupsKey = "studio:deletion-groups";
function routeFromLocation(): Route {
  const match = location.pathname.match(/^\/studio\/([^/]+)\/?$/);
  return match
    ? { screen: "studio", projectId: decodeURIComponent(match[1]) }
    : { screen: "home" };
}
const deletionTimerKey = (id: string) => `studio:deletion:${id}:remaining`;
function savedRemaining(id: string) {
  try {
    const value = Number(localStorage.getItem(deletionTimerKey(id)));
    return Number.isFinite(value) && value > 0
      ? Math.min(UNDO_DURATION, value)
      : UNDO_DURATION;
  } catch {
    return UNDO_DURATION;
  }
}
function saveRemaining(id: string, remaining: number) {
  try {
    localStorage.setItem(deletionTimerKey(id), String(Math.max(0, remaining)));
  } catch {
    // Storage can be unavailable in privacy modes; the server still preserves it.
  }
}
function forgetRemaining(id: string) {
  try {
    localStorage.removeItem(deletionTimerKey(id));
  } catch {
    // No local timer to clean up.
  }
}
function savedDeletionGroups() {
  try {
    const value = JSON.parse(localStorage.getItem(deletionGroupsKey) || "[]");
    return Array.isArray(value)
      ? value.filter(
          (group): group is string[] =>
            Array.isArray(group) && group.every((id) => typeof id === "string"),
        )
      : [];
  } catch {
    return [];
  }
}
function saveDeletionGroups(batches: DeletionBatch[]) {
  try {
    localStorage.setItem(
      deletionGroupsKey,
      JSON.stringify(
        batches.map((batch) => batch.items.map((item) => item.id)),
      ),
    );
  } catch {
    // Grouping is a convenience; each pending deletion remains safe on disk.
  }
}
function groupPendingDeletions(items: PendingDeletion[]): DeletionBatch[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const grouped: DeletionBatch[] = [];
  const used = new Set<string>();
  for (const ids of savedDeletionGroups()) {
    const members = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    if (members.length) {
      grouped.push({ id: members[0].id, items: members });
      members.forEach((item) => used.add(item.id));
    }
  }
  for (const item of items)
    if (!used.has(item.id)) grouped.push({ id: item.id, items: [item] });
  return grouped;
}
function AnchorImage({ image }: { image?: string | null }) {
  return image ? (
    <img src={media(image)} alt="Âncora" />
  ) : (
    <span className="no-image">Sem imagem</span>
  );
}
function App() {
  const {
    project: p,
    projects,
    loadList,
    open,
    mutate,
    refresh,
    saving,
    failed,
    error,
    clearError,
    retry,
    past,
    future,
    clipboard,
    copy,
    undo,
    resetEditing,
  } = useStudio();
  const [currentFrame, setCurrentFrame] = useState<{
    segmentId: string;
    timeMs: number;
  } | null>(null);
  const previewContainer = useRef<HTMLDivElement>(null);
  const [route, setRoute] = useState<Route>(() => routeFromLocation()),
    [name, setName] = useState("Projeto sem título"),
    [createOpen, setCreateOpen] = useState(false),
    [falSettings, setFalSettings] = useState<"settings" | "required" | null>(null),
    [dashboardView, setDashboardView] = useState<"home" | "projects">("home"),
    [creating, setCreating] = useState(false),
    [position, setPosition] = useState(0),
    [joinSelection, setJoinSelection] = useState<string[]>([]),
    [playing, setPlaying] = useState(false),
    [volume, setVolume] = useState(100),
    [zoom, setZoom] = useState(1),
    [timelineViewportWidth, setTimelineViewportWidth] = useState(0),
    [scrubbing, setScrubbing] = useState(false),
    [uploading, setUploading] = useState(false),
    [videoPlacement, setVideoPlacement] = useState<{
      video: VideoAsset;
      startTimeMs: number;
      boundaryImages: (string | null)[];
    } | null>(null),
    [dragMediaId, setDragMediaId] = useState<string | null>(null),
    [dragGhost, setDragGhost] = useState<{
      lane: "keyframe" | "video";
      timeMs: number;
    } | null>(null),
    [timelineMove, setTimelineMove] = useState<TimelineMove | null>(null),
    [contextMenu, setContextMenu] = useState<TimelineContextMenu | null>(null),
    [splittingSegmentId, setSplittingSegmentId] = useState<string | null>(null),
    [selectedMediaId, setSelectedMediaId] = useState<string | null>(null),
    [exportOpen, setExportOpen] = useState(false),
    [deleteTargets, setDeleteTargets] = useState<Summary[]>([]),
    [deleting, setDeleting] = useState(false),
    [deleteError, setDeleteError] = useState(""),
    [deletionBatches, setDeletionBatches] = useState<DeletionBatch[]>([]),
    [selecting, setSelecting] = useState(false),
    [selectedProjects, setSelectedProjects] = useState<Set<string>>(
      () => new Set(),
    ),
    [projectQuery, setProjectQuery] = useState(""),
    [projectView, setProjectView] = useState<"grid" | "list">("grid"),
    [deletionFailure, setDeletionFailure] = useState<{
      id: string;
      message: string;
      operation: "undo" | "finalize";
    } | null>(null),
    [deletionAction, setDeletionAction] = useState<{
      id: string;
      operation: "undo" | "finalize";
    } | null>(null);
  const upload = useRef<HTMLInputElement>(null),
    timelineRef = useRef<HTMLDivElement>(null);
  const scrubPointer = useRef<number | null>(null),
    scrubTimeMs = useRef(0),
    scrubFrame = useRef<number | null>(null),
    scrubPositionOverride = useRef<number | null>(null);
  const creatingLock = useRef(false);
  const deletingLock = useRef(false);
  const deletionLocks = useRef(new Set<string>());
  const navigate = useCallback((next: Route, replace = false) => {
    const url = next.screen === "home" ? "/home" : `/studio/${next.projectId}`;
    if (next.screen === "home") useStudio.setState({ project: null });
    history[replace ? "replaceState" : "pushState"]({}, "", url);
    setRoute(next);
  }, []);
  const syncDeletions = useCallback(async () => {
    try {
      const serverPending = await api<PendingDeletion[]>("/deletions");
      setDeletionBatches((current) => {
        const ids = new Set(serverPending.map((item) => item.id));
        for (const batch of current)
          if (!batch.items.some((item) => ids.has(item.id)))
            forgetRemaining(batch.id);
        const next = groupPendingDeletions(serverPending);
        saveDeletionGroups(next);
        return next;
      });
      const hiddenProjectIds = new Set(
        serverPending.map((item) => item.projectId),
      );
      useStudio.setState((state) => ({
        project:
          state.project && hiddenProjectIds.has(state.project.id)
            ? null
            : state.project,
      }));
      await loadList();
    } catch {
      // The regular connection banner handles broader connectivity failures.
    }
  }, [loadList]);
  useEffect(() => {
    if (location.pathname === "/" || routeFromLocation().screen === "home")
      navigate({ screen: "home" }, true);
    const popstate = () => {
      const next = routeFromLocation();
      if (next.screen === "home") useStudio.setState({ project: null });
      setRoute(next);
    };
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, [navigate]);
  useEffect(() => {
    if (route.screen === "studio") void open(route.projectId);
  }, [route]);
  useEffect(() => {
    void loadList();
    void syncDeletions();
    const interval = setInterval(() => void refresh(), 1200);
    const deletionInterval = setInterval(() => void syncDeletions(), 1200);
    return () => {
      clearInterval(interval);
      clearInterval(deletionInterval);
    };
  }, []);
  useEffect(() => {
    setSelectedProjects((current) => {
      const visible = new Set(projects.map((project) => project.id));
      return new Set([...current].filter((id) => visible.has(id)));
    });
  }, [projects]);
  useEffect(() => {
    setPosition(0);
    setJoinSelection([]);
    setPlaying(false);
    setSelectedMediaId(null);
    setVideoPlacement(null);
  }, [p?.id]);
  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const width =
        element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      if (width > 0) setTimelineViewportWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [p?.id]);
  useEffect(
    () => () => {
      if (scrubFrame.current !== null) cancelAnimationFrame(scrubFrame.current);
    },
    [],
  );
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useStudio.getState().saving || useStudio.getState().failed) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  const segments = p ? timeline(p) : [],
    selected = segments.find((s) => s.id === p?.selectedId),
    keyframe = p?.keyframes.find((k) => k.id === p.selectedId),
    staticClip = p?.staticImageClips.find((c) => c.id === p.selectedId),
    videoClip = p?.videoClips?.find((c) => c.id === p.selectedId),
    textClip = p?.textClips?.find((c) => c.id === p.selectedId);
  const keyframes = p ? orderedKeyframes(p) : [],
    totalMs = p ? timelineDurationMs(p) : 0,
    total = totalMs / 1000,
    pixelsPerSecond = 55 * zoom,
    visibleTimelineDurationMs = Math.max(
      totalMs,
      Math.round((timelineViewportWidth / pixelsPerSecond) * 1000),
    ),
    visibleTimelineDuration = visibleTimelineDurationMs / 1000,
    timelineTrackWidth = Math.max(
      timelineViewportWidth,
      (totalMs / 1000) * pixelsPerSecond,
    ),
    conflicts = p ? timelineConflicts(p) : [],
    conflictIds = new Set(conflicts.flatMap((c) => c.itemIds)),
    pending = p ? pendingSegments(p) : [];
  const moveTimes: Record<string, number> = {};
  const moveClipTimes: Record<string, number> = {};
  const moveVideoTimes: Record<string, number> = {};
  if (p && timelineMove?.kind === "keyframe")
    moveTimes[timelineMove.id] = timelineMove.timeMs;
  if (p && timelineMove?.kind === "staticClip")
    moveClipTimes[timelineMove.id] = timelineMove.startTimeMs;
  if (timelineMove?.kind === "videoClip")
    moveVideoTimes[timelineMove.id] = timelineMove.startTimeMs;
  if (p && timelineMove?.kind === "generatedChain")
    for (const id of timelineMove.keyframeIds)
      moveTimes[id] =
        p.keyframes.find((k) => k.id === id)!.timeMs + timelineMove.deltaMs;
  const moveProject = p
    ? withTimelinePositions(p, moveTimes, moveClipTimes, moveVideoTimes)
    : undefined;
  const moveConflicts = moveProject ? timelineConflicts(moveProject) : [];
  const moveInvalid = !!(
    p &&
    timelineMove &&
    (new Set(orderedKeyframes(moveProject!).map((k) => k.timeMs)).size !==
      p.keyframes.length ||
      (timelineMove.kind === "generatedChain" &&
        (() => {
          const moved = new Set(timelineMove.keyframeIds);
          const values = timelineMove.keyframeIds.map((id) => moveTimes[id]);
          const first = Math.min(...values),
            last = Math.max(...values);
          return p.keyframes.some(
            (k) => !moved.has(k.id) && k.timeMs > first && k.timeMs < last,
          );
        })()))
  );

  const library: (MediaAsset | (VideoAsset & { image: string }))[] = [
    ...(p?.media ?? []),
    ...(p?.videos ?? []).map((video) => ({ ...video, image: video.firstImage })),
  ];
  const mediaPreview = library.find((asset) => asset.id === selectedMediaId);
  const draggedVideo = p?.videos?.find((video) => video.id === dragMediaId);
  const importedBoundaryIds = new Set(
    segments.filter((s) => active(s)?.importedVideoId).flatMap((s) => [s.start, s.end]),
  );
  const importedBoundary = !!keyframe && importedBoundaryIds.has(keyframe.id);
  const ready = totalMs > 0 && conflicts.length === 0 && !!(
    p?.videoClips?.length || p?.staticImageClips.length || p?.textClips?.length ||
    segments.some((segment) => active(segment)?.file)
  );
  const act = async (url: string, method = "POST", body?: unknown) => {
    const state = useStudio.getState();
    if (
      /keyframes|static-clips|\/move$/.test(url) &&
      (state.saving || state.failed)
    )
      return Promise.resolve(false);
    const generation = url.match(/^\/segments\/([^/]+)\/generate$/);
    const needsKey = method === "POST" && (url.endsWith("/replace-actor") ||
      (generation && state.project?.segments.find((segment) => segment.id === generation[1])?.settings.model !== "Demo"));
    if (needsKey) {
      try {
        if (!(await api<{ configured: boolean }>("/settings/fal-key")).configured) {
          setFalSettings("required");
          return false;
        }
      } catch {
        useStudio.setState({ error: "Não foi possível verificar a chave da fal.ai." });
        return false;
      }
    }
    return mutate("/projects/" + p!.id + url, method, body).then(
      () => true,
      () => false,
    );
  };
  useEffect(() => {
    setPlaying(false);
  }, [p?.selectedId]);
  const select = (id: string) => {
    setJoinSelection([]);
    setContextMenu(null);
    setSelectedMediaId(null);
    setPlaying(false);
    void act("", "PATCH", { selectedId: id });
  };
  const isVideoId = (id: string) =>
    !!p?.videoClips?.some((clip) => clip.id === id) ||
    segments.some((segment) => segment.id === id && !!active(segment)?.file);
  const joinIds = joinSelection.filter(isVideoId);
  const selectVideo = (event: React.MouseEvent, id: string) => {
    if (!event.ctrlKey && !event.metaKey) {
      select(id);
      return;
    }
    setContextMenu(null);
    setSelectedMediaId(null);
    setPlaying(false);
    setJoinSelection((current) => {
      const ids = current.length ? current.filter(isVideoId) :
        p?.selectedId && p.selectedId !== id && isVideoId(p.selectedId) ? [p.selectedId] : [];
      if (ids.includes(id)) return ids.filter((item) => item !== id);
      return [...ids.slice(-1), id];
    });
  };
  const videoSelected = (id: string) => joinIds.length ? joinIds.includes(id) : p?.selectedId === id;
  const seek = (value: number) => {
    scrubPositionOverride.current = null;
    setPosition(value);
  };
  const updateScrub = (clientX: number, element: HTMLElement) => {
    const nextMs = Math.min(
      visibleTimelineDurationMs,
      pointerTimeMs(clientX, element, zoom),
    );
    scrubTimeMs.current = nextMs;
    scrubPositionOverride.current = nextMs / 1000;
    setPosition(nextMs / 1000);
  };
  const finishScrub = (element: HTMLElement) => {
    const pointerId = scrubPointer.current;
    scrubPointer.current = null;
    setScrubbing(false);
    if (scrubFrame.current !== null) {
      cancelAnimationFrame(scrubFrame.current);
      scrubFrame.current = null;
    }
    const next = scrubTimeMs.current / 1000;
    setPosition(next);
    if (pointerId !== null && element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
  };
  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    kind: TimelineContextMenu["kind"],
    itemId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    select(itemId);
    setContextMenu({
      kind,
      itemId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };
  const createMediaKeyframe = async (mediaId: string, timeMs: number) => {
    setContextMenu(null);
    await act(`/media/${mediaId}/keyframes`, "POST", { timeMs });
  };
  const splitAt = async (segmentId: string, timeMs: number) => {
    if (splittingSegmentId || saving || failed) return;
    setPlaying(false);
    setContextMenu(null);
    setSplittingSegmentId(segmentId);
    try {
      await act(`/segments/${segmentId}/keyframes`, "POST", { timeMs });
    } finally {
      setSplittingSegmentId(null);
    }
  };
  const splitAvailability = (segment: Segment, timeMs: number) => {
    if (
      !currentFrame ||
      currentFrame.segmentId !== segment.id ||
      currentFrame.timeMs !== timeMs ||
      mediaPreview
    )
      return {
        enabled: false,
        reason: "Aguarde um frame válido na posição do cursor",
      };
    const generation = active(segment);
    if (!generation?.file)
      return { enabled: false, reason: "Gere este segmento primeiro" };
    if (stale(p!, segment))
      return {
        enabled: false,
        reason: "Gere uma nova versão antes de extrair um keyframe deste vídeo",
      };
    const interval = segmentInterval(p!, segment);
    if (timeMs <= interval.startTimeMs || timeMs >= interval.endTimeMs)
      return {
        enabled: false,
        reason: "Posicione o cursor dentro deste segmento",
      };
    if (p!.keyframes.some((item) => item.timeMs === timeMs))
      return { enabled: false, reason: "Já existe um keyframe nesta posição" };
    return { enabled: true, reason: "" };
  };
  const editingBlocked = !!saving || failed || !!splittingSegmentId;
  const needleMs = Math.round(position * 1000);
  const cutTarget = videoClip
    ? { id: videoClip.id, start: videoClip.startTimeMs,
        end: videoClip.startTimeMs + videoClip.durationMs, detached: true }
    : selected && p && active(selected)?.file
      ? { id: selected.id, start: segmentInterval(p, selected).startTimeMs,
          end: Math.min(segmentInterval(p, selected).endTimeMs,
            segmentInterval(p, selected).startTimeMs + active(selected)!.durationMs), detached: false }
      : undefined;
  const canCut = !!cutTarget && needleMs > cutTarget.start && needleMs < cutTarget.end && !editingBlocked;
  const cutAtNeedle = (id: string, detached: boolean) => {
    setPlaying(false);
    setContextMenu(null);
    return detached
      ? act(`/video-clips/${id}/split`, "POST", { timeMs: needleMs })
      : act(`/segments/${id}/detach`, "POST", { cutTimeMs: needleMs });
  };
  const textConflict = () => useStudio.setState({ error: "Já existe texto neste intervalo." });
  const addText = async (startTimeMs: number) => {
    if (!p || editingBlocked) return;
    if (textOverlaps(p.textClips ?? [], { id: "", startTimeMs, durationMs: defaultText.durationMs })) {
      textConflict();
      return;
    }
    setSelectedMediaId(null);
    if (await act("/text-clips", "POST", { startTimeMs })) seek(startTimeMs / 1000);
  };
  const textDrag = useTextDrag(p?.textClips ?? [], pixelsPerSecond, editingBlocked, async (id, startTimeMs, durationMs) => {
    if (!id) return addText(startTimeMs);
    const ok = await act(`/text-clips/${id}`, "PATCH", { startTimeMs, durationMs });
    if (ok) {
      setSelectedMediaId(null);
      setPlaying(false);
      setPosition(startTimeMs / 1000);
    }
  }, textConflict);
  const addTimeMs = p ? keyframeTarget(p, position * 1000) : 0;
  const copyable = !!keyframe || !!staticClip;
  const paste = async () => {
    if (!p || !clipboard || editingBlocked) return;
    if (clipboard.kind === "keyframe") {
      const mediaId = clipboard.image
        ? p.media.find((m) => m.image === clipboard.image)?.id
        : undefined;
      const importedFrame = isImportedFrame(p, clipboard.image) ? clipboard.image : undefined;
      if (clipboard.image && !mediaId && !importedFrame) return;
      await act("/keyframes", "POST", {
        name: clipboard.name,
        timeMs: addTimeMs,
        mediaId,
        importedFrame,
      });
    } else {
      let startTimeMs = Math.max(0, Math.round(position * 1000));
      const end = startTimeMs + clipboard.durationMs;
      if (
        p.staticImageClips.some(
          (c) =>
            startTimeMs < c.startTimeMs + c.durationMs && end > c.startTimeMs,
        ) ||
        segments.some((s) => {
          const t = segmentInterval(p, s);
          return active(s) && startTimeMs < t.endTimeMs && end > t.startTimeMs;
        })
      )
        startTimeMs = totalMs;
      await act(`/media/${clipboard.mediaId}/static-clips`, "POST", {
        startTimeMs,
        durationMs: clipboard.durationMs,
      });
    }
  };
  const frameSegment =
    currentFrame && segments.find((s) => s.id === currentFrame.segmentId);
  const frameAvailable =
    !!frameSegment &&
    !mediaPreview &&
    splitAvailability(frameSegment, Math.round(position * 1000)).enabled &&
    !editingBlocked;
  const pasteAvailable =
    !!clipboard &&
    !!p &&
    (clipboard.kind === "static"
      ? p.media.some((m) => m.id === clipboard.mediaId)
      : !clipboard.image || isImportedFrame(p, clipboard.image) ||
        p.media.some((m) => m.image === clipboard.image));
  useEffect(() => {
    if (route.screen !== "studio") resetEditing();
  }, [route.screen]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".timeline-context-menu"))
        setContextMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [contextMenu]);
  useEffect(() => {
    setContextMenu(null);
  }, [p?.id, route.screen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setDragGhost(null);
        return;
      }
      if (
        route.screen !== "studio" ||
        !p ||
      videoPlacement ||
        exportOpen ||
        deleteTargets.length ||
        editingBlocked
      )
        return;
      const editing = event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement &&
            (target.matches("input, textarea, select") ||
              target.isContentEditable),
        );
      if (editing) return;
      if (
        event.ctrlKey &&
        ["z", "y", "c", "v"].includes(event.key.toLowerCase())
      ) {
        const key = event.key.toLowerCase();
        if (key === "z" && (event.shiftKey ? future.length : past.length)) {
          event.preventDefault();
          void undo(event.shiftKey);
        } else if (key === "y" && future.length) {
          event.preventDefault();
          void undo(true);
        } else if (key === "c" && copyable) {
          event.preventDefault();
          copy();
        } else if (key === "v" && pasteAvailable) {
          event.preventDefault();
          void paste();
        }
        return;
      }
      if (!["Delete", "Backspace"].includes(event.key)) return;
      if (keyframe && !importedBoundary) {
        event.preventDefault();
        void act(`/keyframes/${keyframe.id}`, "DELETE");
      } else if (staticClip) {
        event.preventDefault();
        void act(`/static-clips/${staticClip.id}`, "DELETE");
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [
    route.screen,
    p?.id,
    p?.selectedId,
    editingBlocked,
    past,
    future,
    clipboard,
    position,
    copyable,
    pasteAvailable,
    keyframe?.id,
    staticClip?.id,
    exportOpen,
    deleteTargets.length,
    videoPlacement,
    importedBoundary,
  ]);
  const showProject = (id: string) =>
    navigate({ screen: "studio", projectId: id });
  async function create() {
    if (creatingLock.current || !name.trim()) return;
    creatingLock.current = true;
    setCreating(true);
    try {
      const created = await api<Project>("/projects", "POST", { name });
      await loadList();
      setCreateOpen(false);
      await showProject(created.id);
    } catch (e) {
      useStudio.setState({ error: String(e) });
    } finally {
      creatingLock.current = false;
      setCreating(false);
    }
  }
  async function confirmDelete() {
    if (!deleteTargets.length || deletingLock.current) return;
    deletingLock.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const pending = await api<PendingDeletion[]>("/deletions", "POST", {
        projectIds: deleteTargets.map((project) => project.id),
      });
      const batch: DeletionBatch = { id: pending[0].id, items: pending };
      saveRemaining(batch.id, UNDO_DURATION);
      setDeletionBatches((current) => {
        const next = [...current, batch];
        saveDeletionGroups(next);
        return next;
      });
      const deletedIds = new Set(pending.map((item) => item.projectId));
      useStudio.setState((state) => ({
        projects: state.projects.filter((item) => !deletedIds.has(item.id)),
        project:
          state.project && deletedIds.has(state.project.id)
            ? null
            : state.project,
      }));
      setDeleteTargets([]);
      setSelectedProjects(new Set());
      setSelecting(false);
      if (route.screen === "studio" && deletedIds.has(route.projectId))
        navigate({ screen: "home" });
      await loadList();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      deletingLock.current = false;
      setDeleting(false);
    }
  }
  async function runDeletionOperation(
    batch: DeletionBatch,
    operation: "undo" | "finalize",
  ) {
    if (deletionLocks.current.has(batch.id)) return;
    deletionLocks.current.add(batch.id);
    setDeletionAction({ id: batch.id, operation });
    setDeletionFailure(null);
    try {
      const results = await Promise.allSettled(
        batch.items.map((item) =>
          operation === "undo"
            ? api(`/deletions/${item.id}/undo`, "POST")
            : api(`/deletions/${item.id}`, "DELETE"),
        ),
      );
      const failedItems = batch.items.filter(
        (_item, index) => results[index].status === "rejected",
      );
      if (failedItems.length) {
        const firstFailure = results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult;
        const nextBatch = { id: failedItems[0].id, items: failedItems };
        if (nextBatch.id !== batch.id) {
          saveRemaining(nextBatch.id, savedRemaining(batch.id));
          forgetRemaining(batch.id);
        }
        setDeletionBatches((current) => {
          const next = current.map((item) =>
            item.id === batch.id ? nextBatch : item,
          );
          saveDeletionGroups(next);
          return next;
        });
        setDeletionFailure({
          id: nextBatch.id,
          operation,
          message:
            firstFailure.reason instanceof Error
              ? firstFailure.reason.message
              : String(firstFailure.reason),
        });
      } else {
        forgetRemaining(batch.id);
        setDeletionBatches((current) => {
          const next = current.filter((item) => item.id !== batch.id);
          saveDeletionGroups(next);
          return next;
        });
      }
      await loadList();
    } finally {
      deletionLocks.current.delete(batch.id);
      setDeletionAction((current) =>
        current?.id === batch.id ? null : current,
      );
    }
  }
  async function importMedia(files: FileList | null) {
    if (!files?.length || !p || uploading) return;
    setUploading(true);
    const projectId = p.id;
    const existing = new Set(library.map((asset) => asset.id));
    const videos = Array.from(files).filter((file) => /\.(mp4|mov)$/i.test(file.name));
    const images = Array.from(files).filter((file) => !videos.includes(file));
    try {
      if (images.length) {
        const form = new FormData();
        images.forEach((file) => form.append("images", file));
        if (!(await act("/images", "POST", form))) return;
      }
      for (const video of videos) {
        if (useStudio.getState().project?.id !== projectId) return;
        const form = new FormData();
        form.append("video", video);
        if (!(await act("/videos", "POST", form))) break;
      }
      const current = useStudio.getState().project;
      if (current?.id !== projectId) return;
      const firstNew = [...current.media, ...(current.videos ?? [])].find((asset) => !existing.has(asset.id));
      if (firstNew) {
        setPlaying(false);
        setSelectedMediaId(firstNew.id);
      }
    } finally {
      setUploading(false);
      if (upload.current) upload.current.value = "";
    }
  }
  function snapVideoStart(video: VideoAsset, pointerMs: number) {
    const candidates = keyframes.flatMap((k) => [k.timeMs, k.timeMs - video.durationMs]);
    const nearest = candidates.filter((candidate) => candidate >= 0).reduce(
      (best, candidate) => Math.abs(candidate - pointerMs) < Math.abs(best - pointerMs) ? candidate : best,
      Infinity,
    );
    return Math.abs(nearest - pointerMs) * 55 * zoom / 1000 <= 8 ? nearest : pointerMs;
  }
  async function placeVideo(video: VideoAsset, startTimeMs: number, boundaryImages?: (string | null)[]) {
    if (!p || saving) return;
    const error = videoPlacementError(p, video, startTimeMs);
    if (error) {
      useStudio.setState({ error });
      return;
    }
    const previousImages = [startTimeMs, startTimeMs + video.durationMs].map(
      (timeMs) => p.keyframes.find((k) => k.timeMs === timeMs)?.image || null,
    );
    if (!boundaryImages && previousImages.some((image, index) => image && image !== [video.firstImage, video.lastImage][index])) {
      setVideoPlacement({ video, startTimeMs, boundaryImages: previousImages });
      return;
    }
    setVideoPlacement(null);
    if (await act(`/videos/${video.id}/clips`, "POST", { startTimeMs, boundaryImages })) {
      setSelectedMediaId(null);
      setPlaying(false);
      setPosition(startTimeMs / 1000);
    }
  }
  async function addKeyframe(mediaId: string, timeMs: number) {
    await act(`/media/${mediaId}/keyframes`, "POST", { timeMs });
    setDragMediaId(null);
    setDragGhost(null);
  }
  async function addStaticClip(mediaId: string, startTimeMs: number) {
    await act(`/media/${mediaId}/static-clips`, "POST", {
      startTimeMs,
      durationMs: 4000,
    });
    setDragMediaId(null);
    setDragGhost(null);
  }
  function movedAt(pointerMs: number): TimelineMove | null {
    if (!timelineMove || !p) return null;
    if (timelineMove.kind === "keyframe")
      return {
        ...timelineMove,
        timeMs: Math.max(0, pointerMs - timelineMove.grabOffsetMs),
      };
    if (timelineMove.kind === "staticClip" || timelineMove.kind === "videoClip")
      return {
        ...timelineMove,
        startTimeMs: Math.max(0, pointerMs - timelineMove.grabOffsetMs),
      };
    const first = p.keyframes.find(
      (k) => k.id === timelineMove.keyframeIds[0],
    )!;
    const requested = pointerMs - timelineMove.grabOffsetMs - first.timeMs;
    return { ...timelineMove, deltaMs: Math.max(requested, -first.timeMs) };
  }
  function previewMove(pointerMs: number) {
    const next = movedAt(pointerMs);
    if (next) setTimelineMove(next);
  }
  function finishMove(pointerMs: number) {
    const next = movedAt(pointerMs);
    if (!next || !p) return;
    const times: Record<string, number> = {};
    if (next.kind === "keyframe") times[next.id] = next.timeMs;
    if (next.kind === "generatedChain")
      for (const id of next.keyframeIds)
        times[id] = p.keyframes.find((k) => k.id === id)!.timeMs + next.deltaMs;
    const candidate = withTimelinePositions(
      p,
      times,
      next.kind === "staticClip" ? { [next.id]: next.startTimeMs } : {},
      next.kind === "videoClip" ? { [next.id]: next.startTimeMs } : {},
    );
    const duplicate =
      new Set(orderedKeyframes(candidate).map((k) => k.timeMs)).size !==
      p.keyframes.length;
    let interleaves = false;
    if (next.kind === "generatedChain") {
      const moved = new Set(next.keyframeIds);
      const values = next.keyframeIds.map((id) => times[id]);
      const first = Math.min(...values),
        last = Math.max(...values);
      interleaves = p.keyframes.some(
        (k) => !moved.has(k.id) && k.timeMs > first && k.timeMs < last,
      );
    }
    if (!duplicate && !interleaves) {
      if (next.kind === "keyframe")
        void act(`/keyframes/${next.id}`, "PATCH", { timeMs: next.timeMs });
      else if (next.kind === "staticClip")
        void act(`/static-clips/${next.id}`, "PATCH", {
          startTimeMs: next.startTimeMs,
        });
      else if (next.kind === "videoClip") {
        if (timelineConflicts(candidate).some((conflict) => conflict.itemIds.includes(next.id)))
          useStudio.setState({ error: "Escolha um espaço sem outro vídeo ou imagem." });
        else void act(`/video-clips/${next.id}`, "PATCH", { startTimeMs: next.startTimeMs });
      }
      else
        void act(`/segments/${next.segmentId}/move`, "PATCH", {
          deltaMs: next.deltaMs,
        });
    }
    setTimelineMove(null);
  }

  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase();
  const visibleProjects = normalizedProjectQuery
    ? projects.filter((project) =>
        project.name.toLocaleLowerCase().includes(normalizedProjectQuery),
      )
    : projects;
  const toggleProjectSelection = (projectId: string) =>
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  return (
    <div
      className={`app ${route.screen === "home" ? "dashboard-app" : "studio-app"}`}
    >
      {route.screen === "home" ? (
        <header className="topbar home-topbar">
          <Brand />
          <span className="dashboard-breadcrumb">
            Seu espaço criativo <ChevronRight size={13} />{" "}
            {dashboardView === "home" ? "Início" : "Projetos"}
          </span>
          <div className="top-spacer" />
          <span className="home-status">
            <span className="small-dot" /> Workspace local
          </span>
        </header>
      ) : (
        <header className="topbar studio-topbar">
          <Brand compact />
          <button
            className="project-switch"
            onClick={() => {
              void loadList();
              navigate({ screen: "home" });
            }}
          >
            <FolderOpen size={15} />
            {p?.name || "Projetos"}
            <span className="muted">⌄</span>
          </button>
          <span className={"save-state " + (failed ? "warning" : "")}>
            {saving ? (
              <LoaderCircle size={13} className="spin" />
            ) : failed ? (
              <RefreshCw size={13} />
            ) : (
              <Check size={13} />
            )}{" "}
            {saving
              ? "Salvando…"
              : failed
                ? "Falha ao salvar"
                : "Salvo localmente"}
          </span>
          <div className="top-spacer" />
          <span className="demo-label">
            <span /> Geração com IA
          </span>
          <button
            className="primary export"
            disabled={!p || !ready || !!saving}
            onClick={() => setExportOpen(true)}
          >
            <Download size={15} />
            Exportar
          </button>
        </header>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {localError(error)}
          {failed && (
            <button onClick={() => void retry()}>
              <RefreshCw size={14} />
              Tentar novamente
            </button>
          )}
          <button aria-label="Dispensar erro" onClick={clearError}>
            <X size={16} />
          </button>
        </div>
      )}
      {route.screen === "home" ? (
        <div className="dashboard-shell">
          <aside className="dashboard-sidebar">
            <p className="nav-caption">WORKSPACE</p>
            <nav aria-label="Navegação principal">
              <button
                className={dashboardView === "home" ? "active" : ""}
                aria-current={dashboardView === "home" ? "page" : undefined}
                onClick={() => {
                  setDashboardView("home");
                  setProjectQuery("");
                }}
              >
                <House size={18} /> Início
              </button>
              <button
                className={dashboardView === "projects" ? "active" : ""}
                aria-current={dashboardView === "projects" ? "page" : undefined}
                onClick={() => setDashboardView("projects")}
              >
                <FolderOpen size={18} /> Projetos{" "}
                <span className="nav-count">{projects.length}</span>
              </button>
              <button onClick={() => setFalSettings("settings")} aria-haspopup="dialog">
                <SlidersHorizontal size={18} /> Configurações
              </button>
            </nav>
            <div className="sidebar-note">
              <Sparkles size={20} />
              <strong>Da ideia ao movimento.</strong>
              <p>Conecte seus frames e dê vida à sua próxima história.</p>
              <button onClick={() => setCreateOpen(true)}>
                Começar a criar <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="workspace-identity">
              <span>PC</span>
              <div>
                Meu workspace
                <small>
                  <i className="small-dot" /> Salvo neste computador
                </small>
              </div>
            </div>
          </aside>
          <main className="library">
            <div className="dashboard-greeting">
              <span>Seu estúdio, suas possibilidades.</span>
              <span className="workspace-badge">
                <span className="small-dot" /> Workspace local
              </span>
            </div>
            <div className="library-heading">
              <div>
                <p className="eyebrow">MINERV.AI / ESTÚDIO CRIATIVO</p>
                <h1>
                  {dashboardView === "home"
                    ? "Grandes histórias."
                    : "Suas ideias."}
                  <br />
                  <span>
                    {dashboardView === "home"
                      ? "O seu próximo frame."
                      : "Em movimento."}
                  </span>
                </h1>
                <p className="muted">
                  Transforme imagens em vídeos. Explore possibilidades. Crie do
                  seu jeito.
                </p>
                <button
                  className="primary hero-create"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={18} /> Criar projeto <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="hero-orbit" />
                <div className="hero-frame frame-back">
                  <span>01 / IDEIA</span>
                  <div className="art-landscape" />
                </div>
                <div className="hero-frame frame-front">
                  <span>
                    02 / MOVIMENTO <Sparkles size={12} />
                  </span>
                  <div className="art-landscape">
                    <div className="art-play">
                      <Play size={24} fill="currentColor" />
                    </div>
                  </div>
                </div>
                <span className="hero-art-caption">
                  <span className="small-dot" /> IMAGINE. CONECTE. CRIE.
                </span>
              </div>
            </div>
            <div className="section-title library-section-title">
              <div className="recent-title">
                <h2>
                  {dashboardView === "home"
                    ? "Projetos recentes"
                    : "Todos os projetos"}
                </h2>
                {!!projects.length && (
                  <button
                    className={
                      selecting ? "select-projects active" : "select-projects"
                    }
                    onClick={() => {
                      setSelecting((current) => !current);
                      setSelectedProjects(new Set());
                    }}
                  >
                    <CheckSquare2 size={14} />
                    {selecting ? "Cancelar" : "Selecionar"}
                  </button>
                )}
              </div>
              <span className="muted project-count">
                {projects.length} projeto{projects.length === 1 ? "" : "s"} ·
                Neste computador
              </span>
            </div>
            {!!projects.length && (
              <div className="library-controls">
                <label className="project-search">
                  <Search size={15} />
                  <input
                    type="search"
                    aria-label="Buscar projetos"
                    placeholder="Buscar projetos"
                    value={projectQuery}
                    onChange={(event) => setProjectQuery(event.target.value)}
                  />
                </label>
                <div
                  className="view-toggle"
                  aria-label="Visualização dos projetos"
                >
                  <button
                    className={projectView === "grid" ? "active" : ""}
                    aria-label="Visualização em grade"
                    aria-pressed={projectView === "grid"}
                    onClick={() => setProjectView("grid")}
                  >
                    <Grid2X2 size={15} />
                  </button>
                  <button
                    className={projectView === "list" ? "active" : ""}
                    aria-label="Visualização em lista"
                    aria-pressed={projectView === "list"}
                    onClick={() => setProjectView("list")}
                  >
                    <List size={16} />
                  </button>
                </div>
                {selecting && (
                  <button
                    className={
                      selectedProjects.size
                        ? "bulk-delete primary"
                        : "bulk-delete"
                    }
                    disabled={!selectedProjects.size}
                    onClick={() => {
                      setDeleteError("");
                      setDeleteTargets(
                        projects.filter((project) =>
                          selectedProjects.has(project.id),
                        ),
                      );
                    }}
                  >
                    <Trash2 size={15} />
                    Excluir
                    {!!selectedProjects.size && ` (${selectedProjects.size})`}
                  </button>
                )}
              </div>
            )}
            <div className={`project-grid ${projectView}-view`}>
              {visibleProjects.map((item) => (
                <article
                  className={
                    "project-card " +
                    (selectedProjects.has(item.id) ? "selected" : "")
                  }
                  key={item.id}
                >
                  <button
                    className="project-cover"
                    onDragStart={(event) => event.preventDefault()}
                    onClick={() =>
                      selecting
                        ? toggleProjectSelection(item.id)
                        : showProject(item.id)
                    }
                  >
                    {item.cover ? (
                      <img src={media(item.cover)} draggable={false} />
                    ) : (
                      <Film size={38} />
                    )}
                    <span>
                      Abrir projeto <ChevronRight size={14} />
                    </span>
                  </button>
                  <div className="project-card-info">
                    <div>
                      <div className="project-name-row">
                        {selecting && (
                          <label className="project-checkbox">
                            <input
                              type="checkbox"
                              aria-label={`Selecionar ${item.name}`}
                              checked={selectedProjects.has(item.id)}
                              onChange={() => toggleProjectSelection(item.id)}
                            />
                            <span aria-hidden="true" />
                          </label>
                        )}
                        <button
                          className="text-button"
                          onClick={() =>
                            selecting
                              ? toggleProjectSelection(item.id)
                              : showProject(item.id)
                          }
                        >
                          {item.name}
                        </button>
                      </div>
                      <p>
                        {item.count} keyframes ·{" "}
                        {new Date(item.updatedAt).toLocaleDateString("pt-BR")}
                      </p>
                    </div>
                    {!selecting && (
                      <button
                        className="icon-button danger"
                        aria-label={"Excluir " + item.name}
                        onClick={() => {
                          setDeleteError("");
                          setDeleteTargets([item]);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {!!projects.length && !visibleProjects.length && (
              <div className="library-empty search-empty">
                <Search size={24} />
                <p>Nenhum projeto encontrado para “{projectQuery}”.</p>
              </div>
            )}
            {!projects.length && (
              <div className="library-empty">
                <FolderOpen size={26} />
                <h3>Sua próxima história começa aqui.</h3>
                <p>
                  Crie um projeto, importe suas imagens e conecte os primeiros
                  keyframes.
                </p>
                <button className="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} /> Criar meu primeiro projeto
                </button>
              </div>
            )}
          </main>
        </div>
      ) : (
        p && (
          <>
            <div className="workspace">
              <aside className="media-panel panel">
                <div className="panel-heading">
                  <span>Mídia</span>
                  <span className="muted">
                    {library.length} {library.length === 1 ? "arquivo" : "arquivos"}
                  </span>
                </div>
                <button
                  className="import-button"
                  onClick={() => upload.current?.click()}
                  disabled={uploading}
                >
                  <Upload size={15} />
                  {uploading ? "Importando…" : "Importar mídia"}
                </button>
                <input
                  ref={upload}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.mp4,.mov"
                  multiple
                  hidden
                  onChange={(e) => void importMedia(e.target.files)}
                />
                <section className="text-library" aria-label="Texto">
                  <span className="eyebrow">Texto</span>
                  <AddTextCard drag={textDrag} disabled={editingBlocked} add={() => void addText(Math.round(position * 1000))} />
                </section>
                <div className="media-subtitle">
                  MÍDIA DO PROJETO<span>JPG · PNG · WEBP · MP4 · MOV</span>
                </div>
                <div
                  className="asset-grid"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    if (e.dataTransfer.files.length) {
                      e.preventDefault();
                      void importMedia(e.dataTransfer.files);
                    }
                  }}
                >
                  {library.map((asset) => (
                    <button
                      key={asset.id}
                      draggable
                      onDragStart={(event) => {
                        setDragMediaId(asset.id);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => {
                        setDragMediaId(null);
                        setDragGhost(null);
                      }}
                      onClick={() => {
                        setPlaying(false);
                        setSelectedMediaId(asset.id);
                      }}
                      className={
                        "asset " +
                        (selectedMediaId === asset.id ? "selected" : "")
                      }
                    >
                      <div>
                        <img src={media(asset.image)} draggable={false} />
                        <span className="asset-number">{"file" in asset ? "VÍDEO" : "IMG"}</span>
                      </div>
                      <span title={asset.name}>{asset.name}</span>
                    </button>
                  ))}
                </div>
                {!library.length && (
                  <button
                    className="dropzone"
                    onClick={() => upload.current?.click()}
                  >
                    <ImageIcon size={28} />
                    <strong>Importe imagens e vídeos</strong>
                    <span>
                      Guarde sua mídia aqui e adicione
                      <br />à timeline quando quiser.
                    </span>
                  </button>
                )}
                <div className="media-footer">
                  <span className="small-dot" /> Mídia original salva neste
                  computador
                </div>
              </aside>
              <main className="viewer panel">
                <div className="panel-heading">
                  <span>
                    Preview <span className="slash">/</span>
                    <span className="muted">
                      {mediaPreview
                        ? `Prévia da mídia · ${mediaPreview.name}`
                        : "Sequência completa"}
                    </span>
                  </span>
                </div>
                <div className="preview-stage">
                  <div
                    ref={previewContainer}
                    className="preview-picture"
                    style={{ aspectRatio: p.format.ratio.replace(":", "/") }}
                  >
                    {mediaPreview && "file" in mediaPreview ? (
                      <video
                        key={mediaPreview.id}
                        src={media(mediaPreview.file)}
                        poster={media(mediaPreview.firstImage)}
                        controls
                        playsInline
                        ref={(element) => {
                          if (element) element.volume = volume / 100;
                        }}
                      />
                    ) : mediaPreview ? (
                      <img
                        key={mediaPreview.id}
                        className="media-preview-image"
                        src={media(mediaPreview.image)}
                        draggable={false}
                        alt={mediaPreview.name}
                      />
                    ) : (
                      <SequencePlayer
                        key={p.id}
                        project={p}
                        position={position}
                        playing={playing}
                        volume={volume / 100}
                        onPosition={setPosition}
                        onPlaying={setPlaying}
                        onFrame={setCurrentFrame}
                        editingDisabled={editingBlocked}
                        onSelectLayer={(id) => { if (id !== p.selectedId) select(id); }}
                        onTransformLayer={(id, transform) =>
                          act(`/layer-transforms/${id}`, "PATCH", transform)}
                      />
                    )}
                  </div>
                </div>
                <div className="player-controls">
                  <input
                    aria-label="Posição de reprodução"
                    type="range"
                    min={0}
                    max={total || 1}
                    step="0.05"
                    value={position}
                    disabled={!!mediaPreview}
                    onChange={(e) => seek(Number(e.target.value))}
                  />
                  <div>
                    <span className="timecode">
                      {time(position)}
                      <span> / {time(total)}</span>
                    </span>
                    <div className="play-buttons">
                      <button
                        aria-label="Voltar ao início"
                        disabled={!!mediaPreview}
                        onClick={() => seek(0)}
                      >
                        <SkipBack size={17} />
                      </button>
                      <button
                        aria-label={playing ? "Pausar" : "Reproduzir"}
                        className="play"
                        disabled={totalMs <= 0 || !!mediaPreview}
                        onClick={() => {
                          if (position >= total) setPosition(0);
                          setPlaying(!playing);
                        }}
                      >
                        {playing ? <Pause size={22} /> : <Play size={22} />}
                      </button>
                    </div>
                    <div className="viewer-format">
                      <label className="player-volume">
                        {volume === 0 ? (
                          <VolumeX size={16} aria-hidden="true" />
                        ) : (
                          <Volume2 size={16} aria-hidden="true" />
                        )}
                        <input
                          aria-label="Volume geral"
                          aria-valuetext={`${volume}%`}
                          type="range"
                          min={0}
                          max={100}
                          value={volume}
                          onChange={(e) => setVolume(e.currentTarget.valueAsNumber)}
                        />
                      </label>
                      <span>{p.format.ratio}</span>
                      <button
                        aria-label="Preview em tela cheia"
                        onClick={() =>
                          void previewContainer.current?.requestFullscreen()
                        }
                        disabled={false}
                      >
                        <Maximize size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </main>
              <aside className="inspector panel">
                <div className="inspector-tabs">
                  <span className="inspector-tab-label on">
                    <Sparkles size={14} />
                    {mediaPreview
                      ? "Mídia"
                      : videoClip ? "Vídeo" : textClip ? "Texto" : selected
                        ? "Gerar vídeo"
                        : keyframe
                          ? "Keyframe"
                          : staticClip
                            ? "Imagem estática"
                            : "Projeto"}
                  </span>
                  <span className="muted">Inspetor</span>
                </div>
                {mediaPreview ? (
                  <div className="inspector-content media-inspector">
                    <p className="eyebrow">PRÉVIA DA MÍDIA</p>
                    <img
                      className="inspector-image"
                      src={media(mediaPreview.image)}
                      draggable={false}
                    />
                    <h3 className="filename">{mediaPreview.name}</h3>
                    {"file" in mediaPreview ? (
                      <>
                        <p className="help">
                          Duração {time(mediaPreview.durationMs / 1000)}. Arraste o vídeo
                          para a faixa de vídeo ou insira na posição do cursor.
                        </p>
                        <button
                          className="primary wide"
                          disabled={!!saving}
                          onClick={() => void placeVideo(mediaPreview, Math.round(position * 1000))}
                        >
                          <Plus size={15} /> Inserir no cursor
                        </button>
                      </>
                    ) : (
                      <p className="help">Adicione esta imagem à timeline para usá-la na sua sequência.</p>
                    )}
                  </div>
                ) : videoClip ? (
                  <div className="inspector-content">
                    <p className="eyebrow">VÍDEO DESAGRUPADO</p>
                    <p className="help">Início {time(videoClip.startTimeMs / 1000)} · Duração {(videoClip.durationMs / 1000).toFixed(3)} s</p>
                    <button className="wide" disabled={!canCut} onClick={() => void cutAtNeedle(videoClip.id, true)}>
                      <Scissors size={15} /> Cortar na agulha
                    </button>
                  </div>
                ) : textClip ? (
                  <TextInspector key={JSON.stringify(textClip)} clip={textClip}
                    clips={p.textClips ?? []} saving={!!saving}
                    save={async (fields) => {
                      const ok = await act(`/text-clips/${textClip.id}`, "PATCH", fields);
                      if (ok) { setPlaying(false); setPosition(fields.startTimeMs / 1000); }
                      return ok;
                    }}
                    remove={() => void act(`/text-clips/${textClip.id}`, "DELETE")} />
                ) : selected ? (
                  <SegmentInspector p={p} s={selected} act={act} />
                ) : staticClip ? (
                  <StaticClipInspector
                    key={staticClip.id}
                    clip={staticClip}
                    p={p}
                    act={act}
                  />
                ) : keyframe ? (
                  <div className="inspector-content">
                    <p className="eyebrow">
                      KEYFRAME{" "}
                      {String(p.keyframes.indexOf(keyframe) + 1).padStart(
                        2,
                        "0",
                      )}
                    </p>
                    {keyframe.image ? (
                      <img
                        className="inspector-image"
                        src={media(keyframe.image)}
                      />
                    ) : (
                      <div className="no-image">Sem imagem</div>
                    )}
                    <label>
                      Nome
                      <input
                        key={keyframe.id + keyframe.name}
                        defaultValue={keyframe.name}
                        disabled={!!saving || failed}
                        onBlur={(e) => {
                          if (e.target.value !== keyframe.name)
                            void act(`/keyframes/${keyframe.id}`, "PATCH", {
                              name: e.target.value,
                            });
                        }}
                      />
                    </label>
                    <label>
                      Posição (ms)
                      <input
                        key={keyframe.id + ":" + keyframe.timeMs}
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={keyframe.timeMs}
                        disabled={!!saving || failed || importedBoundary}
                        onBlur={(e) => {
                          if (Number(e.target.value) !== keyframe.timeMs)
                            void act(`/keyframes/${keyframe.id}`, "PATCH", {
                              timeMs: Number(e.target.value),
                            });
                        }}
                      />
                    </label>
                    <label>
                      {keyframe.image
                        ? "Substituir imagem"
                        : "Adicionar imagem"}
                      <select
                        aria-label={
                          keyframe.image
                            ? "Substituir imagem"
                            : "Adicionar imagem"
                        }
                        value=""
                        disabled={!!saving || failed || importedBoundary}
                        onChange={(e) => {
                          if (e.target.value)
                            void act(`/keyframes/${keyframe.id}`, "PATCH", {
                              mediaId: e.target.value,
                            });
                        }}
                      >
                        <option value="">Escolha uma imagem...</option>
                        {p.media.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {keyframe.image && (
                      <button
                        disabled={!!saving || failed || importedBoundary}
                        onClick={() =>
                          void act(`/keyframes/${keyframe.id}`, "PATCH", {
                            image: null,
                          })
                        }
                      >
                        Remover imagem
                      </button>
                    )}
                    <p className="help">
                      {importedBoundary
                        ? "Este quadro é uma borda do vídeo importado. Arraste o clipe para mover a junção."
                        : "Importe imagens na biblioteca de mídia para usá-las aqui."}
                    </p>
                    <h3 className="filename">{keyframe.name}</h3>
                    <p className="help">
                      Âncora temporal em {(keyframe.timeMs / 1000).toFixed(1)}s.
                    </p>
                    <button
                      className="wide danger"
                      disabled={importedBoundary}
                      onClick={() =>
                        void act("/keyframes/" + keyframe.id, "DELETE")
                      }
                    >
                      <Trash2 size={15} />
                      Remover keyframe
                    </button>
                  </div>
                ) : (
                  <div className="inspector-content">
                    <SlidersHorizontal size={26} />
                    <h3>Configurações do projeto</h3>
                    <p className="help">
                      Defina o formato do vídeo. Selecione um segmento na
                      timeline para configurar a geração.
                    </p>
                    <label>
                      Nome do projeto
                      <input
                        defaultValue={p.name}
                        key={p.name}
                        maxLength={100}
                        onBlur={(e) => {
                          if (e.target.value !== p.name)
                            void act("", "PATCH", { name: e.target.value });
                        }}
                      />
                    </label>
                    <FormatControls
                      format={p.format}
                      change={(format) => void act("", "PATCH", { format })}
                    />
                  </div>
                )}
                <button
                  className="project-settings-link"
                  onClick={() => {
                    setSelectedMediaId(null);
                    void act("", "PATCH", { selectedId: null });
                  }}
                >
                  <SlidersHorizontal size={13} /> Configurações ·{" "}
                  {p.format.resolution}p · {p.format.fps} fps
                </button>
              </aside>
            </div>
            <section className="timeline panel">
              <div className="timeline-toolbar">
                <div>
                  <Film size={16} />
                  <strong>Timeline</strong>
                  <span className="muted">
                    {p.keyframes.length} keyframes{" "}
                    <span className="slash">/</span> {segments.length} segmentos
                  </span>
                </div>
                <div className="timeline-actions">
                  {joinIds.length === 2 && (
                    <button className="primary" disabled={editingBlocked}
                      onClick={async () => {
                        if (await act("/video-clips/join", "POST", { clipIds: joinIds }))
                          setJoinSelection([]);
                      }}>
                      <Link size={14} /> Unir
                    </button>
                  )}
                  <button
                    disabled={editingBlocked}
                    title={`Criar em ${(addTimeMs / 1000).toFixed(3)}s`}
                    onClick={() =>
                      void act("/keyframes", "POST", { timeMs: addTimeMs })
                    }
                  >
                    Adicionar keyframe
                  </button>
                  <button
                    disabled={!frameAvailable}
                    title={
                      frameAvailable
                        ? "Extrair o frame de vídeo exibido"
                        : "Requer um frame de vídeo carregado dentro de um segmento atualizado"
                    }
                    onClick={() => {
                      if (frameSegment)
                        void splitAt(
                          frameSegment.id,
                          Math.round(position * 1000),
                        );
                    }}
                  >
                    Extrair keyframe
                  </button>
                  <button disabled={!canCut} title="Selecione um vídeo e posicione a agulha dentro dele"
                    onClick={() => { if (cutTarget) void cutAtNeedle(cutTarget.id, cutTarget.detached); }}>
                    <Scissors size={14} /> Cortar na agulha
                  </button>
                  <button
                    disabled={editingBlocked || !past.length}
                    onClick={() => void undo()}
                  >
                    Desfazer
                  </button>
                  <button
                    disabled={editingBlocked || !future.length}
                    onClick={() => void undo(true)}
                  >
                    Refazer
                  </button>
                  <button disabled={editingBlocked || !copyable} onClick={copy}>
                    Copiar
                  </button>
                  <button
                    disabled={editingBlocked || !pasteAvailable}
                    onClick={() => void paste()}
                  >
                    Colar
                  </button>
                  <button
                    className="text-button"
                    disabled={
                      !pending.some(
                        (s) =>
                          !s.generations.some((g) =>
                            ["Queued", "Generating"].includes(g.status),
                          ),
                      ) ||
                      !!saving ||
                      failed
                    }
                    onClick={async () => {
                      for (const s of pending.filter(
                        (s) =>
                          !s.generations.some((g) =>
                            ["Queued", "Generating"].includes(g.status),
                          ),
                      ))
                        await act("/segments/" + s.id + "/generate");
                    }}
                  >
                    <Sparkles size={14} />
                    Gerar pendentes
                  </button>
                  <span className="divider" />
                  <button
                    aria-label="Diminuir zoom"
                    onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                  >
                    <Minus size={14} />
                  </button>
                  <input
                    aria-label="Zoom da timeline"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.25"
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                  />
                  <button
                    aria-label="Aumentar zoom"
                    onClick={() => setZoom(Math.min(3, zoom + 0.25))}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <div className="timeline-body">
                <div className="track-label">
                  <span className="text-track-label">TEXTO</span>
                  <span>KEYFRAMES</span>
                  <span className="track-divider" />
                  <span>VIDEO</span>
                  <Film size={17} />
                </div>
                <div
                  className={
                    "timeline-scroll " + (dragMediaId ? "accepting-media" : "")
                  }
                  ref={timelineRef}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    )
                      setDragGhost(null);
                  }}
                >
                  <div
                    className="timeline-track"
                    style={{ width: timelineTrackWidth }}
                  >
                    <TextTrack clips={p.textClips ?? []} selectedId={p.selectedId}
                      pixelsPerSecond={pixelsPerSecond} drag={textDrag} onSelect={(id) => select(id)} />
                    <div
                      className={`ruler${scrubbing ? " scrubbing" : ""}`}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        setContextMenu(null);
                        setSelectedMediaId(null);
                        setPlaying(false);
                        scrubPointer.current = e.pointerId;
                        scrubTimeMs.current = Math.round(position * 1000);
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setScrubbing(true);
                        updateScrub(e.clientX, e.currentTarget);
                      }}
                      onPointerMove={(e) => {
                        if (scrubPointer.current !== e.pointerId) return;
                        e.preventDefault();
                        updateScrub(e.clientX, e.currentTarget);
                      }}
                      onPointerUp={(e) => {
                        if (scrubPointer.current !== e.pointerId) return;
                        e.preventDefault();
                        updateScrub(e.clientX, e.currentTarget);
                        finishScrub(e.currentTarget);
                      }}
                      onPointerCancel={(e) => {
                        if (scrubPointer.current === e.pointerId)
                          finishScrub(e.currentTarget);
                      }}
                      onLostPointerCapture={(e) => {
                        if (scrubPointer.current === e.pointerId)
                          finishScrub(e.currentTarget);
                      }}
                    >
                      {Array.from(
                        { length: Math.floor(visibleTimelineDuration) + 1 },
                        (_, i) => (
                          <span key={i} style={{ left: i * pixelsPerSecond }}>
                            {i % 2 === 0 ? time(i) : "·"}
                          </span>
                        ),
                      )}
                    </div>
                    <div
                      className="clips video-lane"
                      onDragOver={(event) => {
                        if (!dragMediaId && !timelineMove) return;
                        event.preventDefault();
                        const pointerMs = pointerTimeMs(
                          event.clientX,
                          event.currentTarget,
                          zoom,
                        );
                        if (dragMediaId)
                          setDragGhost({
                            lane: "video",
                            timeMs: draggedVideo ? snapVideoStart(draggedVideo, pointerMs) : pointerMs,
                          });
                        else if (
                          timelineMove?.kind === "staticClip" ||
                          timelineMove?.kind === "videoClip" ||
                          timelineMove?.kind === "generatedChain"
                        )
                          previewMove(pointerMs);
                      }}
                      onDrop={(event) => {
                        if (dragMediaId) {
                          event.preventDefault();
                          const pointerMs = pointerTimeMs(event.clientX, event.currentTarget, zoom);
                          if (draggedVideo) {
                            setDragMediaId(null);
                            setDragGhost(null);
                            void placeVideo(draggedVideo, snapVideoStart(draggedVideo, pointerMs));
                          } else void addStaticClip(dragMediaId, pointerMs);
                        } else if (
                          timelineMove?.kind === "staticClip" ||
                          timelineMove?.kind === "videoClip" ||
                          timelineMove?.kind === "generatedChain"
                        ) {
                          event.preventDefault();
                          finishMove(
                            pointerTimeMs(
                              event.clientX,
                              event.currentTarget,
                              zoom,
                            ),
                          );
                        }
                      }}
                    >
                      {segments
                        .filter((s) => !!active(s))
                        .map((s) => {
                          const g = active(s),
                            status = s.generations.at(-1)?.status || "Idle",
                            interval = segmentInterval(p, s);
                          return (
                            <button
                              key={s.id}
                              draggable
                              className={
                                "clip " +
                                s.settings.continuity.toLowerCase() +
                                (status === "Generating" ? " generating" : "") +
                                (conflictIds.has(s.id) ? " conflict" : "") +
                                (stale(p, s) ? " outdated" : "") +
                                (videoSelected(s.id) ? " selected" : "") +
                                (timelineMove?.kind === "generatedChain" &&
                                timelineMove.keyframeIds.includes(s.start)
                                  ? " dragging"
                                  : "")
                              }
                              style={{
                                left: (interval.startTimeMs / 1000) * 55 * zoom,
                                width:
                                  (segmentDurationMs(p, s) / 1000) * 55 * zoom,
                              }}
                              onDragStart={(event) => {
                                const chain = generatedChain(p, s.id);
                                const lane = event.currentTarget.parentElement!;
                                const pointerMs = pointerTimeMs(
                                  event.clientX,
                                  lane,
                                  zoom,
                                );
                                select(s.id);
                                setTimelineMove({
                                  kind: "generatedChain",
                                  segmentId: s.id,
                                  grabOffsetMs:
                                    pointerMs - chain.keyframes[0].timeMs,
                                  deltaMs: 0,
                                  keyframeIds: chain.keyframes.map((k) => k.id),
                                });
                                event.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => setTimelineMove(null)}
                              aria-pressed={videoSelected(s.id)}
                              onClick={(event) => selectVideo(event, s.id)}
                              onContextMenu={(event) =>
                                openContextMenu(event, "segment", s.id)
                              }
                            >
                              <div className="clip-label">
                                {stale(p, s) && (
                                  <span className="outdated-label">
                                    ⚠ Desatualizado
                                  </span>
                                )}
                                {s.settings.continuity === "Cut" ? (
                                  <Scissors size={11} />
                                ) : (
                                  <Link size={11} />
                                )}
                                <span>{g?.importedVideoId ? "Importado" : label(s.settings.continuity)}</span>
                                <span
                                  className={
                                    "status-dot " + status.toLowerCase()
                                  }
                                />
                              </div>
                              <div className="clip-thumbnails">
                                <AnchorImage
                                  image={
                                    p.keyframes.find((k) => k.id === s.start)
                                      ?.image
                                  }
                                />
                                <AnchorImage
                                  image={
                                    p.keyframes.find((k) => k.id === s.end)
                                      ?.image
                                  }
                                />
                              </div>
                              <div className="clip-footer">
                                <span>
                                  {g?.importedVideoId ? "Vídeo" : g
                                    ? "V" + (s.generations.indexOf(g) + 1)
                                    : label(status)}
                                </span>
                                <span>
                                  {(segmentDurationMs(p, s) / 1000).toFixed(1)}s
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      {(p.videoClips ?? []).map((clip) => (
                        <button key={clip.id} draggable={!editingBlocked}
                          className={`clip static-clip independent-video${videoSelected(clip.id) ? " selected" : ""}${conflictIds.has(clip.id) ? " conflict" : ""}`}
                          style={{ left: clip.startTimeMs / 1000 * pixelsPerSecond, width: clip.durationMs / 1000 * pixelsPerSecond }}
                          aria-pressed={videoSelected(clip.id)}
                          onClick={(event) => selectVideo(event, clip.id)}
                          onContextMenu={(event) => openContextMenu(event, "videoClip", clip.id)}
                          onDragStart={(event) => {
                            const pointerMs = pointerTimeMs(event.clientX, event.currentTarget.parentElement!, zoom);
                            select(clip.id);
                            setTimelineMove({ kind: "videoClip", id: clip.id,
                              grabOffsetMs: pointerMs - clip.startTimeMs, startTimeMs: clip.startTimeMs });
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => setTimelineMove(null)}>
                          <div className="clip-label"><Film size={12} /> Vídeo desagrupado</div>
                          <div className="clip-footer">{(clip.durationMs / 1000).toFixed(3)} s</div>
                        </button>
                      ))}
                      {timelineMove?.kind === "videoClip" && (
                        <div className={`ghost-static moving${moveConflicts.some((conflict) => conflict.itemIds.includes(timelineMove.id)) ? " invalid" : ""}`}
                          style={{ left: timelineMove.startTimeMs / 1000 * pixelsPerSecond,
                            width: ((p.videoClips?.find((clip) => clip.id === timelineMove.id)?.durationMs ?? 0) / 1000) * pixelsPerSecond }}>
                          <span>Mover vídeo</span>
                        </div>
                      )}
                      {p.staticImageClips.map((clip) => {
                        const asset = p.media.find(
                          (item) => item.id === clip.mediaId,
                        )!;
                        return (
                          <button
                            key={clip.id}
                            draggable
                            className={
                              "clip static-clip" +
                              (conflictIds.has(clip.id) ? " conflict" : "") +
                              (staticClip?.id === clip.id ? " selected" : "") +
                              (timelineMove?.kind === "staticClip" &&
                              timelineMove.id === clip.id
                                ? " dragging"
                                : "")
                            }
                            style={{
                              left: (clip.startTimeMs / 1000) * 55 * zoom,
                              width: (clip.durationMs / 1000) * 55 * zoom,
                            }}
                            onDragStart={(event) => {
                              const lane = event.currentTarget.parentElement!;
                              const pointerMs = pointerTimeMs(
                                event.clientX,
                                lane,
                                zoom,
                              );
                              select(clip.id);
                              setTimelineMove({
                                kind: "staticClip",
                                id: clip.id,
                                grabOffsetMs: pointerMs - clip.startTimeMs,
                                startTimeMs: clip.startTimeMs,
                              });
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => setTimelineMove(null)}
                            onClick={() => select(clip.id)}
                            onContextMenu={(event) =>
                              openContextMenu(event, "staticClip", clip.id)
                            }
                          >
                            <div className="clip-label">
                              <ImageIcon size={11} />
                              <span>Imagem estática</span>
                            </div>
                            <div className="clip-thumbnails">
                              <img src={media(asset.image)} draggable={false} />
                            </div>
                            <div className="clip-footer">
                              <span>{asset.name}</span>
                              <span>
                                {(clip.durationMs / 1000).toFixed(1)}s
                              </span>
                            </div>
                          </button>
                        );
                      })}
                      {dragGhost?.lane === "video" && (
                        <div
                          className="ghost-static"
                          style={{
                            left: (dragGhost.timeMs / 1000) * 55 * zoom,
                            width: (draggedVideo ? draggedVideo.durationMs / 1000 : 4) * 55 * zoom,
                          }}
                        >
                          <span>{draggedVideo ? "Adicionar vídeo" : "Adicionar imagem estática · 4,0s"}</span>
                        </div>
                      )}
                      {timelineMove?.kind === "staticClip" && (
                        <div
                          className={
                            "ghost-static moving" +
                            (moveConflicts.some((c) =>
                              c.itemIds.includes(timelineMove.id),
                            )
                              ? " conflict"
                              : "")
                          }
                          style={{
                            left: (timelineMove.startTimeMs / 1000) * 55 * zoom,
                            width:
                              (p.staticImageClips.find(
                                (c) => c.id === timelineMove.id,
                              )!.durationMs /
                                1000) *
                              55 *
                              zoom,
                          }}
                        >
                          <span>
                            {(timelineMove.startTimeMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                      )}
                      {timelineMove?.kind === "generatedChain" &&
                        generatedChain(p, timelineMove.segmentId).segments.map(
                          (segment) => {
                            const original = segmentInterval(p, segment);
                            const interval = {
                              startTimeMs:
                                original.startTimeMs + timelineMove.deltaMs,
                              endTimeMs:
                                original.endTimeMs + timelineMove.deltaMs,
                            };
                            return (
                              <div
                                key={segment.id}
                                className={
                                  "ghost-generated" +
                                  (moveInvalid ? " invalid" : "") +
                                  (moveConflicts.some((c) =>
                                    c.itemIds.includes(segment.id),
                                  )
                                    ? " conflict"
                                    : "")
                                }
                                style={{
                                  left:
                                    (interval.startTimeMs / 1000) * 55 * zoom,
                                  width:
                                    ((interval.endTimeMs -
                                      interval.startTimeMs) /
                                      1000) *
                                    55 *
                                    zoom,
                                }}
                              >
                                <span>
                                  {timelineMove.deltaMs >= 0 ? "+" : ""}
                                  {(timelineMove.deltaMs / 1000).toFixed(1)}s
                                </span>
                              </div>
                            );
                          },
                        )}
                    </div>
                    <div
                      className="playhead"
                      style={{ left: position * 55 * zoom }}
                    >
                      <span />
                    </div>
                    <div
                      className="keyframe-markers keyframe-lane"
                      onDragOver={(event) => {
                        if (draggedVideo || (!dragMediaId && timelineMove?.kind !== "keyframe"))
                          return;
                        event.preventDefault();
                        const pointerMs = pointerTimeMs(
                          event.clientX,
                          event.currentTarget,
                          zoom,
                        );
                        if (dragMediaId)
                          setDragGhost({ lane: "keyframe", timeMs: pointerMs });
                        else previewMove(pointerMs);
                      }}
                      onDrop={(event) => {
                        if (draggedVideo) return;
                        if (dragMediaId) {
                          event.preventDefault();
                          void addKeyframe(
                            dragMediaId,
                            pointerTimeMs(
                              event.clientX,
                              event.currentTarget,
                              zoom,
                            ),
                          );
                        } else if (timelineMove?.kind === "keyframe") {
                          event.preventDefault();
                          finishMove(
                            pointerTimeMs(
                              event.clientX,
                              event.currentTarget,
                              zoom,
                            ),
                          );
                        }
                      }}
                    >
                      {segments.filter((segment) => !segment.detached).map((segment) => {
                        const interval = segmentInterval(p, segment);
                        const status =
                          segment.generations.at(-1)?.status || "Idle";
                        return (
                          <button
                            key={segment.id}
                            className={
                              "keyframe-connection " +
                              status.toLowerCase() +
                              (selected?.id === segment.id ? " selected" : "")
                            }
                            style={{
                              left: (interval.startTimeMs / 1000) * 55 * zoom,
                              width:
                                (segmentDurationMs(p, segment) / 1000) *
                                55 *
                                zoom,
                            }}
                            onClick={() => select(segment.id)}
                            onContextMenu={(event) =>
                              openContextMenu(event, "segment", segment.id)
                            }
                          >
                            <span>
                              {active(segment)?.importedVideoId ? "Importado" : label(segment.settings.continuity)} ·{" "}
                              {(segmentDurationMs(p, segment) / 1000).toFixed(
                                1,
                              )}
                              s
                            </span>
                          </button>
                        );
                      })}
                      {segments.map((segment) => {
                        const interval = segmentInterval(p, segment);
                        const playheadMs = Math.round(position * 1000);
                        const targetTimeMs =
                          playheadMs > interval.startTimeMs &&
                          playheadMs < interval.endTimeMs
                            ? playheadMs
                            : Math.round(
                                (interval.startTimeMs + interval.endTimeMs) / 2,
                              );
                        const availability = splitAvailability(
                          segment,
                          targetTimeMs,
                        );
                        return (
                          <button
                            key={`add-${segment.id}`}
                            className={
                              "inline-add-keyframe" +
                              (selected?.id === segment.id ? " visible" : "")
                            }
                            style={{
                              left:
                                ((interval.startTimeMs + interval.endTimeMs) /
                                  2000) *
                                55 *
                                zoom,
                            }}
                            disabled={
                              !availability.enabled ||
                              splittingSegmentId === segment.id
                            }
                            title={
                              availability.reason || "Adicionar keyframe aqui"
                            }
                            aria-label="Adicionar keyframe"
                            onClick={(event) => {
                              event.stopPropagation();
                              void splitAt(segment.id, targetTimeMs);
                            }}
                          >
                            {splittingSegmentId === segment.id ? "…" : "+"}
                          </button>
                        );
                      })}
                      {keyframes.map((k, i) => (
                        <button
                          key={k.id}
                          draggable={!importedBoundaryIds.has(k.id)}
                          style={{
                            left: (k.timeMs / 1000) * 55 * zoom,
                          }}
                          onClick={() => select(k.id)}
                          className={
                            (keyframe?.id === k.id ? "on" : "") +
                            (timelineMove?.kind === "keyframe" &&
                            timelineMove.id === k.id
                              ? " dragging"
                              : "") +
                            (timelineMove?.kind === "generatedChain" &&
                            timelineMove.keyframeIds.includes(k.id)
                              ? " dragging"
                              : "")
                          }
                          onDragStart={(event) => {
                            const lane = event.currentTarget.parentElement!;
                            const pointerMs = pointerTimeMs(
                              event.clientX,
                              lane,
                              zoom,
                            );
                            select(k.id);
                            setTimelineMove({
                              kind: "keyframe",
                              id: k.id,
                              grabOffsetMs: pointerMs - k.timeMs,
                              timeMs: k.timeMs,
                            });
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => setTimelineMove(null)}
                        >
                          ◆ <span>{String(i + 1).padStart(2, "0")}</span>
                        </button>
                      ))}
                      {timelineMove?.kind === "keyframe" && (
                        <>
                          {timeline(moveProject!)
                            .filter(
                              (segment) =>
                                segment.start === timelineMove.id ||
                                segment.end === timelineMove.id,
                            )
                            .map((segment) => {
                              const interval = segmentInterval(
                                moveProject!,
                                segment,
                              );
                              return (
                                <div
                                  key={segment.id}
                                  className={
                                    "ghost-connection moving" +
                                    (moveInvalid ? " invalid" : "") +
                                    (moveConflicts.length ? " conflict" : "")
                                  }
                                  style={{
                                    left:
                                      (interval.startTimeMs / 1000) * 55 * zoom,
                                    width:
                                      ((interval.endTimeMs -
                                        interval.startTimeMs) /
                                        1000) *
                                      55 *
                                      zoom,
                                  }}
                                >
                                  <span>
                                    {(
                                      (interval.endTimeMs -
                                        interval.startTimeMs) /
                                      1000
                                    ).toFixed(1)}
                                    s
                                  </span>
                                </div>
                              );
                            })}
                          <div
                            className={
                              "ghost-keyframe moving" +
                              (moveInvalid ? " invalid" : "") +
                              (moveConflicts.length ? " conflict" : "")
                            }
                            style={{
                              left: (timelineMove.timeMs / 1000) * 55 * zoom,
                            }}
                          >
                            <span>◇</span>
                            <small>
                              {(timelineMove.timeMs / 1000).toFixed(1)}s
                              {moveInvalid ? " · inválido" : ""}
                            </small>
                          </div>
                        </>
                      )}
                      {timelineMove?.kind === "generatedChain" &&
                        timelineMove.keyframeIds.map((id, index) => {
                          const original = p.keyframes.find(
                            (k) => k.id === id,
                          )!;
                          const candidate =
                            original.timeMs + timelineMove.deltaMs;
                          return (
                            <div
                              key={id}
                              className={
                                "ghost-keyframe chain" +
                                (moveInvalid ? " invalid" : "")
                              }
                              style={{ left: (candidate / 1000) * 55 * zoom }}
                            >
                              <span>◇</span>
                              <small>
                                K{index + 1} · {(candidate / 1000).toFixed(1)}s
                              </small>
                            </div>
                          );
                        })}
                      {dragGhost?.lane === "keyframe" &&
                        (() => {
                          const before = keyframes
                            .filter((k) => k.timeMs < dragGhost.timeMs)
                            .at(-1);
                          const after = keyframes.find(
                            (k) => k.timeMs > dragGhost.timeMs,
                          );
                          return (
                            <>
                              {before && (
                                <div
                                  className="ghost-connection"
                                  style={{
                                    left: (before.timeMs / 1000) * 55 * zoom,
                                    width:
                                      ((dragGhost.timeMs - before.timeMs) /
                                        1000) *
                                      55 *
                                      zoom,
                                  }}
                                >
                                  <span>
                                    {(
                                      (dragGhost.timeMs - before.timeMs) /
                                      1000
                                    ).toFixed(1)}
                                    s
                                  </span>
                                </div>
                              )}
                              {after && (
                                <div
                                  className="ghost-connection"
                                  style={{
                                    left: (dragGhost.timeMs / 1000) * 55 * zoom,
                                    width:
                                      ((after.timeMs - dragGhost.timeMs) /
                                        1000) *
                                      55 *
                                      zoom,
                                  }}
                                >
                                  <span>
                                    {(
                                      (after.timeMs - dragGhost.timeMs) /
                                      1000
                                    ).toFixed(1)}
                                    s
                                  </span>
                                </div>
                              )}
                              <div
                                className="ghost-keyframe"
                                style={{
                                  left: (dragGhost.timeMs / 1000) * 55 * zoom,
                                }}
                              >
                                <span>◇</span>
                                <small>
                                  Adicionar como keyframe ·{" "}
                                  {(dragGhost.timeMs / 1000).toFixed(1)}s
                                </small>
                              </div>
                            </>
                          );
                        })()}
                    </div>
                    {conflicts.map((conflict, index) => (
                      <div
                        key={index}
                        className="conflict-range"
                        style={{
                          left: (conflict.startTimeMs / 1000) * 55 * zoom,
                          width:
                            ((conflict.endTimeMs - conflict.startTimeMs) /
                              1000) *
                            55 *
                            zoom,
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <footer className="timeline-footer">
                <span>
                  <span className="small-dot" /> Workspace local
                </span>
                <span className={conflicts.length ? "warning" : ""}>
                  {conflicts.length
                    ? `Sobreposição: ${(conflicts[0].startTimeMs / 1000).toFixed(1)}s–${(conflicts[0].endTimeMs / 1000).toFixed(1)}s. Resolva antes de exportar.`
                    : "Clique na timeline para voltar à prévia da sequência"}
                </span>
                <span>{time(total)} total</span>
              </footer>
            </section>
          </>
        )
      )}
      {contextMenu &&
        p &&
        (() => {
          const left = Math.max(
            8,
            Math.min(contextMenu.clientX, window.innerWidth - 248),
          );
          const top = Math.max(
            8,
            Math.min(contextMenu.clientY, window.innerHeight - 260),
          );
          if (contextMenu.kind === "segment") {
            const segment = segments.find(
              (item) => item.id === contextMenu.itemId,
            );
            if (!segment) return null;
            const timeMs = Math.round(position * 1000);
            const availability = splitAvailability(segment, timeMs);
            const generation = active(segment);
            return (
              <div
                className="timeline-context-menu"
                role="menu"
                style={{ left, top }}
              >
                <button
                  role="menuitem"
                  disabled={!availability.enabled || !!splittingSegmentId}
                  title={availability.reason}
                  onClick={() => void splitAt(segment.id, timeMs)}
                >
                  Usar frame atual como keyframe
                </button>
                {!availability.enabled && <small>{availability.reason}</small>}
                {generation?.file && <>
                  <button role="menuitem" disabled={!canCut}
                    onClick={() => void cutAtNeedle(segment.id, false)}>
                    Cortar na agulha
                  </button>
                  <button role="menuitem" disabled={editingBlocked} onClick={() => {
                    setContextMenu(null);
                    void act(`/segments/${segment.id}/detach`);
                  }}>
                    Desagrupar vídeo
                  </button>
                </>}
                {generation && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setContextMenu(null);
                      void act(`/segments/${segment.id}/active`, "DELETE");
                    }}
                  >
                    Remover vídeo ativo
                  </button>
                )}
              </div>
            );
          }
          if (contextMenu.kind === "videoClip") {
            const clip = p.videoClips?.find((item) => item.id === contextMenu.itemId);
            if (!clip) return null;
            return (
              <div className="timeline-context-menu" role="menu" style={{ left, top }}>
                <button role="menuitem" disabled={!canCut}
                  onClick={() => void cutAtNeedle(clip.id, true)}>Cortar na agulha</button>
                <button role="menuitem" disabled={editingBlocked} onClick={() => {
                  setContextMenu(null);
                  void act(`/video-clips/${clip.id}`, "DELETE");
                }}>Remover clipe</button>
              </div>
            );
          }
          const clip = p.staticImageClips.find(
            (item) => item.id === contextMenu.itemId,
          );
          if (!clip) return null;
          const playheadMs = Math.round(position * 1000);
          const choices = [
            ["Criar keyframe no início", clip.startTimeMs],
            ["Criar keyframe no cursor", playheadMs],
            ["Criar keyframe no fim", clip.startTimeMs + clip.durationMs],
          ] as const;
          return (
            <div
              className="timeline-context-menu"
              role="menu"
              style={{ left, top }}
            >
              {choices.map(([label, timeMs], index) => {
                const inside =
                  index !== 1 ||
                  (timeMs >= clip.startTimeMs &&
                    timeMs < clip.startTimeMs + clip.durationMs);
                const duplicate = p.keyframes.some(
                  (item) => item.timeMs === timeMs,
                );
                const reason = !inside
                  ? "Posicione o cursor dentro deste clipe"
                  : duplicate
                    ? "Já existe um keyframe nesta posição"
                    : "";
                return (
                  <button
                    key={label}
                    role="menuitem"
                    disabled={!!reason}
                    title={reason}
                    onClick={() =>
                      void createMediaKeyframe(clip.mediaId, timeMs)
                    }
                  >
                    {label}
                  </button>
                );
              })}
              <span className="context-menu-separator" />
              <button
                className="danger"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  void act(`/static-clips/${clip.id}`, "DELETE");
                }}
              >
                Excluir
              </button>
            </div>
          );
        })()}
      {exportOpen && p && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Exportar vídeo"
            className="modal"
          >
            <div className="panel-heading">
              <h2>Exporte sua sequência</h2>
              <button
                aria-label="Fechar exportação"
                onClick={() => setExportOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="help">
              {segments.length} segmentos · {time(total)} ·{" "}
              {p.format.resolution}p · {p.format.fps} fps
              <br />
              MP4 / H.264 · Áudio preservado quando disponível
              <br />
              Trechos sem mídia na faixa de vídeo saem com fundo preto.
            </p>
            <p className="help">
              A exportação preserva as versões selecionadas no momento de
              iniciar.
            </p>
            <button
              className="primary wide"
              disabled={
                !!saving ||
                !ready ||
                p.jobs.some(
                  (j) =>
                    j.kind === "export" &&
                    ["Queued", "Generating"].includes(j.status),
                )
              }
              onClick={() => void act("/export")}
            >
              <Download size={16} />
              Exportar MP4
            </button>
            <div className="export-list">
              {p.jobs
                .filter((j) => j.kind === "export")
                .slice()
                .reverse()
                .map((j) => (
                  <div key={j.id}>
                    <span>
                      <strong>
                        {j.status === "Completed"
                          ? "Pronto para baixar"
                          : label(j.status)}
                      </strong>
                      <small>
                        {new Date(j.createdAt).toLocaleTimeString()}
                      </small>
                      {j.error && (
                        <small className="warning">{localError(j.error)}</small>
                      )}
                    </span>
                    {j.status === "Completed" ? (
                      <a
                        className="button"
                        href={`/api/projects/${p.id}/exports/${j.id}/download`}
                      >
                        <Download size={15} />
                        Baixar
                      </a>
                    ) : j.status === "Failed" ? (
                      <button onClick={() => void act("/export")}>
                        Tentar novamente
                      </button>
                    ) : (
                      <LoaderCircle size={18} className="spin" />
                    )}
                  </div>
                ))}
            </div>
          </section>
        </div>
      )}
      {falSettings && <FalSettingsDialog required={falSettings === "required"} onClose={() => setFalSettings(null)} />}
      <CreateProjectDialog
        open={createOpen && route.screen === "home"}
        name={name}
        loading={creating}
        onName={setName}
        onCreate={() => void create()}
        onClose={() => setCreateOpen(false)}
      />
      <ConfirmDialog
        open={!!videoPlacement}
        title="Usar os quadros do vídeo na emenda?"
        description="Os quadros abaixo serão usados nos keyframes de início e fim. Se a imagem de um keyframe mudar, regenere o trecho de IA que usa essa imagem para atualizar a emenda."
        cancelText="Cancelar"
        confirmText="Inserir vídeo"
        onCancel={() => setVideoPlacement(null)}
        onConfirm={() => {
          if (videoPlacement)
            void placeVideo(videoPlacement.video, videoPlacement.startTimeMs, videoPlacement.boundaryImages);
        }}
      >
        {videoPlacement && (
          <div className="frame-pair video-boundary-preview">
            <div><AnchorImage image={videoPlacement.video.firstImage} /><span>INÍCIO</span></div>
            <div><AnchorImage image={videoPlacement.video.lastImage} /><span>FIM</span></div>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleteTargets.length}
        title={
          deleteTargets.length === 1 ? "Excluir projeto?" : "Excluir projetos?"
        }
        description={
          deleteTargets.length === 1
            ? `Excluir “${deleteTargets[0]?.name || ""}”? Você terá alguns segundos para desfazer.`
            : `Excluir ${deleteTargets.length} projetos? Você terá alguns segundos para desfazer.`
        }
        cancelText="Cancelar"
        confirmText={
          deleteTargets.length === 1 ? "Excluir projeto" : "Excluir projetos"
        }
        processingText="Excluindo…"
        destructive
        processing={deleting}
        error={deleteError ? localError(deleteError) : undefined}
        onCancel={() => {
          if (!deleting) {
            setDeleteTargets([]);
            setDeleteError("");
          }
        }}
        onConfirm={() => void confirmDelete()}
      />
      {deletionBatches[0] && (
        <div
          className="toast-region"
          aria-label="Status de exclusão dos projetos"
        >
          <ActionToast
            key={deletionBatches[0].id}
            message={
              deletionBatches[0].items.length === 1
                ? `“${deletionBatches[0].items[0].projectName}” excluído`
                : `${deletionBatches[0].items.length} projetos excluídos`
            }
            actionLabel="Desfazer"
            durationMs={UNDO_DURATION}
            initialRemainingMs={savedRemaining(deletionBatches[0].id)}
            paused={deletionFailure?.id === deletionBatches[0].id}
            processing={deletionAction?.id === deletionBatches[0].id}
            error={
              deletionFailure?.id === deletionBatches[0].id
                ? localError(deletionFailure.message)
                : undefined
            }
            retryLabel="Tentar novamente"
            onRemainingChange={(remaining) =>
              saveRemaining(deletionBatches[0].id, remaining)
            }
            onAction={() =>
              void runDeletionOperation(deletionBatches[0], "undo")
            }
            onRetry={() =>
              void runDeletionOperation(
                deletionBatches[0],
                deletionFailure?.operation || "finalize",
              )
            }
            onExpire={() =>
              void runDeletionOperation(deletionBatches[0], "finalize")
            }
          />
        </div>
      )}
    </div>
  );
}
function FormatControls({
  format,
  change,
}: {
  format: Format;
  change: (f: Format) => void;
}) {
  return (
    <>
      <label>
        Proporção
        <select
          value={format.ratio}
          onChange={(e) =>
            change({ ...format, ratio: e.target.value as Format["ratio"] })
          }
        >
          <option>16:9</option>
          <option>9:16</option>
          <option>1:1</option>
        </select>
      </label>
      <div className="form-row">
        <label>
          Resolução
          <select
            value={format.resolution}
            onChange={(e) =>
              change({
                ...format,
                resolution: Number(e.target.value) as Format["resolution"],
              })
            }
          >
            <option value="1080">1080p</option>
            <option value="720">720p</option>
          </select>
        </label>
        <label>
          Taxa de quadros
          <select
            value={format.fps}
            onChange={(e) =>
              change({
                ...format,
                fps: Number(e.target.value) as Format["fps"],
              })
            }
          >
            {[24, 25, 30].map((n) => (
              <option key={n} value={n}>
                {n} fps
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
function StaticClipInspector({
  clip,
  p,
  act,
}: {
  clip: StaticImageClip;
  p: Project;
  act: (url: string, method?: string, body?: unknown) => Promise<boolean>;
}) {
  const asset = p.media.find((item) => item.id === clip.mediaId)!;
  const [startTimeMs, setStartTimeMs] = useState(clip.startTimeMs);
  const [durationMs, setDurationMs] = useState(clip.durationMs);
  const save = (patch: Partial<StaticImageClip>) =>
    void act(`/static-clips/${clip.id}`, "PATCH", patch);
  return (
    <div className="inspector-content">
      <p className="eyebrow">CLIPE DE IMAGEM</p>
      <img
        className="inspector-image"
        src={media(asset.image)}
        draggable={false}
      />
      <h3 className="filename">{asset.name}</h3>
      <label>
        Início (segundos)
        <input
          type="number"
          min="0"
          step="0.1"
          value={startTimeMs / 1000}
          onChange={(event) =>
            setStartTimeMs(
              Math.max(0, Math.round(Number(event.target.value) * 1000)),
            )
          }
          onBlur={() => save({ startTimeMs })}
        />
      </label>
      <label>
        Duração (segundos)
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={durationMs / 1000}
          onChange={(event) =>
            setDurationMs(
              Math.max(100, Math.round(Number(event.target.value) * 1000)),
            )
          }
          onBlur={() => save({ durationMs })}
        />
      </label>
      <button
        className="wide danger"
        onClick={() => void act(`/static-clips/${clip.id}`, "DELETE")}
      >
        <Trash2 size={15} /> Remover clipe de imagem
      </button>
    </div>
  );
}

function SegmentInspector({
  p,
  s,
  act,
}: {
  p: Project;
  s: Segment;
  act: (url: string, method?: string, body?: unknown) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(s.settings),
    [dirty, setDirty] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [actorMediaId, setActorMediaId] = useState("");
  const editRevision = useRef(0);
  const latest = useRef(s.settings);
  useEffect(() => {
    editRevision.current++;
    latest.current = s.settings;
    setDraft(s.settings);
    setDirty(false);
    setSaveFailed(false);
  }, [s.id]);
  const activeGen = active(s),
    latestGen = s.generations.at(-1),
    pending = s.generations.some((g) =>
      ["Queued", "Generating"].includes(g.status),
    );
  const save = (value: Settings) => {
    const revision = ++editRevision.current;
    setDirty(true);
    setSaveFailed(false);
    void act("/segments/" + s.id, "PATCH", value).then((ok) => {
      if (revision !== editRevision.current) return;
      setDirty(!ok);
      setSaveFailed(!ok);
    });
  };
  const edit = (patch: Partial<Settings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setDraft(next);
    save(next);
  };
  if (activeGen?.importedVideoId) {
    const asset = p.videos?.find((video) => video.id === activeGen.importedVideoId);
    return (
      <div className="inspector-content">
        <p className="eyebrow">VÍDEO IMPORTADO</p>
        <h3 className="filename">{asset?.name}</h3>
        <div className="frame-pair">
          {segmentImages(p, s).map((image, index) => (
            <div key={index}>
              <AnchorImage image={image} />
              <span>{index === 0 ? "FRAME INICIAL" : "FRAME FINAL"}</span>
            </div>
          ))}
        </div>
        <p className="help">Os keyframes deste vídeo podem servir de referência para um trecho de IA antes ou depois dele.</p>
      </div>
    );
  }
  return (
    <div className="inspector-content">
      <div className="segment-heading">
        <span className="eyebrow">
          SEGMENTO {String(timeline(p).indexOf(s) + 1).padStart(2, "0")}
        </span>
        <span
          className={
            "status-badge " + (latestGen?.status || "Idle").toLowerCase()
          }
        >
          {label(latestGen?.status || "Idle")}
        </span>
      </div>
      <div className="frame-pair">
        {[s.start, s.end].map((kid, i) => (
          <React.Fragment key={kid}>
            {i === 1 && <ChevronRight size={16} />}
            <div>
              <AnchorImage
                image={p.keyframes.find((k) => k.id === kid)?.image}
              />
              <span>{i === 0 ? "FRAME INICIAL" : "FRAME FINAL"}</span>
            </div>
          </React.Fragment>
        ))}
      </div>
      <label>
        Descrição
        <textarea
          placeholder="Descreva o movimento entre os keyframes…"
          value={draft.prompt}
          maxLength={4000}
          onChange={(e) => edit({ prompt: e.target.value })}
        />
        <span className="field-note">
          {draft.prompt.length} / 4000 {dirty ? "· Salvando…" : ""}
        </span>
      </label>
      <label>
        Modelo
        <select
          value={draft.model}
          onChange={(e) => edit({ model: e.target.value as Settings["model"] })}
        >
          <option value="Kling V3">Kling V3 · IA</option>
          <option value="Seedance 2.5" disabled>Seedance 2.5 · Indisponível</option>
          <option value="Demo">Demo · Offline</option>
        </select>
      </label>
      <div className="duration-label">
        <label>Duração</label>
        <div>
          <strong>{(segmentDurationMs(p, s) / 1000).toFixed(1)}</strong>
          <span>s</span>
        </div>
      </div>
      <label>Continuidade</label>
      <div className="continuity-options">
        {(["Continuous", "Neutral", "Cut"] as const).map((c) => (
          <button
            key={label(c)}
            className={draft.continuity === c ? "on" : ""}
            onClick={() => edit({ continuity: c })}
          >
            {c === "Cut" ? (
              <Scissors size={13} />
            ) : c === "Continuous" ? (
              <Link size={13} />
            ) : (
              <Minus size={13} />
            )}{" "}
            {label(c)}
          </button>
        ))}
      </div>
      <p className="help continuity-help">
        {draft.continuity === "Continuous"
          ? "Mantenha o fluxo entre as cenas."
          : draft.continuity === "Cut"
            ? "Inicie uma nova cena nesta conexão."
            : "Deixe a conexão aberta à interpretação."}
      </p>
      <label>
        Seed <span className="muted">(opcional)</span>
        <input
          placeholder="Aleatória"
          value={draft.seed}
          inputMode="numeric"
          maxLength={16}
          onChange={(e) => {
            if (/^\d*$/.test(e.target.value)) edit({ seed: e.target.value });
          }}
        />
      </label>
      <button
        className="primary generate wide"
        disabled={pending || dirty || draft.model === "Seedance 2.5"}
        onClick={() => void act("/segments/" + s.id + "/generate")}
      >
        {pending ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Sparkles size={17} />
        )}{" "}
        {pending
          ? latestGen?.status === "Queued"
            ? "Na fila…"
            : "Gerando…"
          : activeGen
            ? "Gerar nova versão"
            : latestGen?.status === "Failed"
              ? "Tentar gerar novamente"
              : "Gerar vídeo"}
      </button>
      {saveFailed && (
        <button className="wide warning" onClick={() => save(latest.current)}>
          <RefreshCw size={14} />
          Tentar salvar configurações
        </button>
      )}
      <p className="demo-note">
        {draft.model === "Demo"
          ? "O modo Demo reproduz um clipe de exemplo e ignora os keyframes e a descrição."
          : draft.model === "Seedance 2.5"
            ? "Seedance 2.5 está indisponível. Selecione Kling V3 ou Demo."
            : "Use uma imagem no primeiro keyframe e segmentos de 3 a 15 segundos. A geração tem custo por uso."}
      </p>
      {draft.model === "Kling V3" && segmentDurationMs(p, s) % 1000 !== 0 &&
        klingDurationSeconds(segmentDurationMs(p, s)) !== undefined && (
          <p className="help">
            A fal.ai recebe e cobra {klingDurationSeconds(segmentDurationMs(p, s))} s.
            O vídeo é ajustado à duração do segmento na timeline.
          </p>
        )}
      {activeGen && (
        <div className="actor-tool">
          <label>
            Modificar atores · imagem de referência
            <select
              value={actorMediaId}
              onChange={(e) => setActorMediaId(e.target.value)}
            >
              <option value="">Selecione uma imagem da biblioteca</option>
              {p.media.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="wide"
            disabled={!actorMediaId || pending}
            onClick={() =>
              void act("/segments/" + s.id + "/replace-actor", "POST", {
                mediaId: actorMediaId,
              })
            }
          >
            Modificar atores
          </button>
          <p className="help">
            Cria uma nova versão do vídeo ativo. Funciona melhor com um ator em
            destaque.
          </p>
        </div>
      )}
      {stale(p, s) && (
        <p className="warning notice">
          Imagens, duração ou configurações mudaram. Gere uma nova versão para
          aplicar as alterações.
        </p>
      )}
      {latestGen?.error && (
        <p className="warning notice">{localError(latestGen.error)}</p>
      )}
      <div className="history-heading">
        <h3>Histórico de versões</h3>
        <span>{s.generations.length}</span>
      </div>
      {!s.generations.length ? (
        <div className="history-empty">
          <Clock3 size={17} />
          <span>
            Suas gerações aparecerão aqui.
            <br />
            As versões anteriores ficam salvas.
          </span>
        </div>
      ) : (
        <div className="version-list">
          {s.generations
            .slice()
            .reverse()
            .map((g, i) => (
              <button
                key={g.id}
                disabled={g.status !== "Completed"}
                className={"version " + (s.activeId === g.id ? "active" : "")}
                onClick={() =>
                  void act("/segments/" + s.id + "/active", "PUT", {
                    generationId: g.id,
                  })
                }
              >
                <div className="version-icon">
                  {g.status === "Completed" ? (
                    <Film size={16} />
                  ) : g.status === "Failed" ? (
                    <X size={16} />
                  ) : (
                    <LoaderCircle size={16} className="spin" />
                  )}
                </div>
                <div>
                  <strong>Versão {s.generations.length - i}</strong>
                  <span>
                    {(g.durationMs / 1000).toFixed(1)}s · {label(g.status)} ·{" "}
                    {new Date(g.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {s.activeId === g.id && <Check size={15} />}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
