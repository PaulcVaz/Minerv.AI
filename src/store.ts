import { localError } from "./labels";
import { create } from "zustand";
import {
  editorStructure,
  type EditorStructure,
  type Project,
} from "../shared/types";
export interface Summary {
  id: string;
  name: string;
  updatedAt: string;
  count: number;
  cover?: string;
}
export async function api<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + url, {
    method,
    headers:
      body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(localError(data.error || "Request failed"));
  return data;
}
type HistoryEntry = { before: EditorStructure; after: EditorStructure };
export type TimelineClipboard =
  | { kind: "keyframe"; name: string; image?: string | null }
  | { kind: "static"; mediaId: string; durationMs: number };
let chain: Promise<unknown> = Promise.resolve();
export const useStudio = create<{
  project: Project | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  clipboard: TimelineClipboard | null;
  resetEditing: () => void;
  copy: () => void;
  undo: (redo?: boolean) => Promise<void>;
  projects: Summary[];
  saving: number;
  failed: boolean;
  failedRequest: { url: string; method: string; body?: unknown } | null;
  error: string;
  loadList: () => Promise<void>;
  open: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  mutate: (url: string, method?: string, body?: unknown) => Promise<void>;
  clearError: () => void;
  retry: () => Promise<void>;
}>((set, get) => ({
  project: null,
  past: [],
  future: [],
  clipboard: null,
  resetEditing: () => set({ past: [], future: [], clipboard: null }),
  copy: () => {
    const p = get().project;
    if (!p) return;
    const k = p.keyframes.find((k) => k.id === p.selectedId),
      c = p.staticImageClips.find((c) => c.id === p.selectedId);
    if (k)
      set({ clipboard: { kind: "keyframe", name: k.name, image: k.image } });
    else if (c)
      set({
        clipboard: {
          kind: "static",
          mediaId: c.mediaId,
          durationMs: c.durationMs,
        },
      });
  },
  undo: async (redo = false) => {
    const state = get(),
      p = state.project;
    const entry = (redo ? state.future : state.past).at(-1);
    if (!p || !entry || state.saving || state.failed) return;
    set({ saving: state.saving + 1 });
    const work = chain.then(async () => {
      try {
        const fresh = await api<Project>(
          `/projects/${p.id}/structure`,
          "POST",
          {
            expected: redo ? entry.before : entry.after,
            target: redo ? entry.after : entry.before,
          },
        );
        if (get().project?.id === p.id)
          set(
            redo
              ? {
                  project: fresh,
                  future: get().future.slice(0, -1),
                  past: [...get().past, entry],
                }
              : {
                  project: fresh,
                  past: get().past.slice(0, -1),
                  future: [...get().future, entry],
                },
          );
      } catch (e) {
        set({ error: localError(e) });
        try {
          const fresh = await api<Project>(`/projects/${p.id}`);
          if (get().project?.id === p.id) set({ project: fresh });
        } catch {}
      } finally {
        set({ saving: get().saving - 1 });
      }
    });
    chain = work.catch(() => {});
    await work;
  },
  projects: [],
  saving: 0,
  failed: false,
  failedRequest: null,
  error: "",
  clearError: () => set({ error: "" }),
  retry: async () => {
    const request = get().failedRequest;
    if (request)
      await get()
        .mutate(request.url, request.method, request.body)
        .catch(() => {});
  },
  loadList: async () => {
    try {
      set({ projects: await api<Summary[]>("/projects") });
    } catch (e) {
      set({ error: localError(e) });
    }
  },
  open: async (id) => {
    await chain;
    get().resetEditing();
    try {
      set({ project: await api<Project>("/projects/" + id), failed: false });
    } catch (e) {
      set({ error: localError(e) });
    }
  },
  refresh: async () => {
    const p = get().project;
    if (!p || get().saving) return;
    try {
      const fresh = await api<Project>("/projects/" + p.id);
      if (
        get().project?.id === fresh.id &&
        !get().saving &&
        fresh.revision >= (get().project?.revision || 0)
      )
        set({ project: fresh });
    } catch (e) {
      set({
        error:
          "Conexão perdida. Seu projeto salvo está seguro. " + localError(e),
      });
    }
  },
  mutate: async (url, method = "POST", body) => {
    set((s) => ({ saving: s.saving + 1 }));
    const pid = get().project?.id;
    const work = chain.then(async () => {
      try {
        const beforeProject = get().project;
        const before = beforeProject && editorStructure(beforeProject);
        const p = await api<Project>(url, method, body);
        if (
          before &&
          beforeProject?.id === p.id &&
          get().project?.id === p.id
        ) {
          const after = editorStructure(p);
          if (JSON.stringify(before) !== JSON.stringify(after))
            set((state) => ({
              past: [...state.past, { before, after }].slice(-100),
              future: [],
            }));
        }
        if (!pid || get().project?.id === p.id) set({ project: p });
        if (get().failedRequest?.url === url)
          set({ failed: false, failedRequest: null, error: "" });
      } catch (e) {
        set({
          failed: true,
          error: localError(e),
          failedRequest: { url, method, body },
        });
        throw e;
      } finally {
        set((s) => ({ saving: s.saving - 1 }));
      }
    });
    chain = work.catch(() => {});
    return work;
  },
}));
