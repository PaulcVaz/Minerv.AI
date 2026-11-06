import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  active,
  clipSource,
  segmentDurationMs,
  segmentInterval,
  signature,
  segmentImages,
  timeline,
  timelineConflicts,
  timelineDurationMs,
  type ExportJob,
} from "../shared/types.ts";
import { id, recover } from "./domain.ts";
import { Store } from "./store.ts";
import {
  composeTimeline,
  FalProvider,
  type CompositionPart,
  type GenerationProvider,
} from "./media.ts";

export class Jobs {
  private queue: (() => Promise<void>)[] = [];
  private busy = false;
  constructor(
    private store: Store,
    private provider: GenerationProvider,
    private getKey: () => string = () => process.env.FAL_KEY || "",
  ) {
    for (const p of store.list()) if (recover(p)) store.save(p);
  }
  private enqueue(work: () => Promise<void>) {
    this.queue.push(work);
    void this.drain();
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length)
        try {
          await this.queue.shift()!();
        } catch (error) {
          console.error("[job]", error);
        }
    } finally {
      this.busy = false;
    }
  }
  get running() {
    return this.busy || this.queue.length > 0;
  }
  private requireKey() {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error("Configure a chave da fal.ai em Configurações."), { status: 428 });
    return key;
  }
  generate(projectId: string, segmentId: string) {
    const p = this.store.get(projectId);
    const s = timeline(p).find((segment) => segment.id === segmentId);
    if (!s) throw new Error("Select a current segment.");
    if (s.detached) throw new Error("O vídeo deste segmento foi desagrupado.");
    if (active(s)?.importedVideoId)
      throw new Error("Selecione um trecho entre keyframes para gerar com IA.");
    if (s.generations.some((g) => ["Queued", "Generating"].includes(g.status)))
      throw new Error("This segment already has a pending generation.");
    const key = s.settings.model === "Demo" ? "" : this.requireKey();
    const generation = {
      id: id(),
      status: "Queued" as const,
      inputImages: segmentImages(p, s),
      settings: structuredClone(s.settings),
      durationMs: segmentDurationMs(p, s),
      format: structuredClone(p.format),
      createdAt: new Date().toISOString(),
    };
    s.generations.push(generation);
    this.store.save(p);
    this.enqueue(async () => {
      const dir = path.join(this.store.root, projectId);
      const file = `${projectId}/${generation.id}.mp4`;
      try {
        await mkdir(dir, { recursive: true });
        let current = this.store.get(projectId);
        current.segments
          .find((segment) => segment.id === segmentId)!
          .generations.find((g) => g.id === generation.id)!.status =
          "Generating";
        this.store.save(current);
        await (key ? new FalProvider(key) : this.provider).generate({
          startImage: generation.inputImages[0]
            ? path.join(this.store.root, generation.inputImages[0])
            : undefined,
          endImage: generation.inputImages[1]
            ? path.join(this.store.root, generation.inputImages[1])
            : undefined,
          settings: generation.settings,
          durationMs: generation.durationMs,
          format: generation.format,
          output: path.join(this.store.root, file),
        });
        current = this.store.get(projectId);
        const segment = current.segments.find((item) => item.id === segmentId)!;
        Object.assign(
          segment.generations.find((g) => g.id === generation.id)!,
          { status: "Completed", file },
        );
        segment.activeId = generation.id;
        this.store.save(current);
      } catch (error) {
        this.failGeneration(projectId, segmentId, generation.id, error, key);
        return;
      }
      try {
        this.ensurePreview(projectId);
      } catch (error) {
        console.error("[preview scheduling]", error);
      }
    });
    return generation;
  }
  replaceActor(projectId: string, segmentId: string, mediaId: string) {
    const p = this.store.get(projectId);
    const segment = timeline(p).find((s) => s.id === segmentId);
    if (!segment) throw new Error("Select a current segment.");
    const source = active(segment);
    if (!source?.file) throw new Error("Generate this segment before replacing its actor.");
    if (source.importedVideoId)
      throw new Error("A troca de atores está disponível em segmentos gerados.");
    if (segment.generations.some((g) => ["Queued", "Generating"].includes(g.status)))
      throw new Error("Wait for the pending generation.");
    const actor = p.media.find((m) => m.id === mediaId);
    if (!actor) throw new Error("Choose an actor image from Media.");
    const key = this.requireKey();
    const generation = {
      id: id(), status: "Queued" as const, inputImages: segmentImages(p, segment),
      settings: structuredClone(segment.settings), durationMs: segmentDurationMs(p, segment),
      format: structuredClone(p.format), createdAt: new Date().toISOString(),
      derivedFromGenerationId: source.id, actorImage: actor.image,
    };
    segment.generations.push(generation);
    this.store.save(p);
    this.enqueue(async () => {
      const file = `${projectId}/${generation.id}.mp4`;
      try {
        const current = this.store.get(projectId);
        current.segments.find((s) => s.id === segmentId)!.generations.find((g) => g.id === generation.id)!.status = "Generating";
        this.store.save(current);
        await new FalProvider(key).replaceActor({
          video: path.join(this.store.root, source.file!),
          actorImage: path.join(this.store.root, actor.image),
          format: generation.format, durationMs: generation.durationMs,
          output: path.join(this.store.root, file),
        });
        const completed = this.store.get(projectId);
        const target = completed.segments.find((s) => s.id === segmentId)!;
        Object.assign(target.generations.find((g) => g.id === generation.id)!, { status: "Completed", file });
        target.activeId = generation.id;
        this.store.save(completed);
      } catch (error) { this.failGeneration(projectId, segmentId, generation.id, error, key); }
    });
    return generation;
  }
  private failGeneration(
    pid: string,
    sid: string,
    gid: string,
    error: unknown,
    key: string,
  ) {
    const message = key ? String(error).replaceAll(key, "[chave protegida]") : String(error);
    console.error("[generation]", message);
    try {
      const p = this.store.get(pid);
      Object.assign(
        p.segments
          .find((s) => s.id === sid)!
          .generations.find((g) => g.id === gid)!,
        { status: "Failed", error: message },
      );
      this.store.save(p);
    } catch {}
  }
  ensurePreview(pid: string) {
    // Preview is resolved immediately by the client.
  }
  compose(pid: string, kind: "preview" | "export"): ExportJob {
    const p = this.store.get(pid);
    const segments = timeline(p).filter((segment) => !!active(segment)?.file);
    if (
      timelineDurationMs(p) <= 0 ||
      (!segments.some((segment) => !!active(segment)) &&
        !p.staticImageClips.length && !p.textClips?.length && !p.videoClips?.length)
    )
      throw Object.assign(new Error("Add timeline content before exporting."), { status: 409 });
    if (timelineConflicts(p).length)
      throw new Error("Resolve overlapping media before exporting.");
    const generations = segments.map((s) => active(s)!);
    const job: ExportJob = {
      id: id(),
      kind,
      signature: signature(p),
      generationIds: [...generations.map((g) => g.id), ...(p.videoClips ?? []).map((clip) => clip.generationId)],
      format: structuredClone(p.format),
      status: "Queued",
      createdAt: new Date().toISOString(),
    };
    const placed: {
      startTimeMs: number;
      endTimeMs: number;
      part: CompositionPart;
    }[] = [
      ...segments.map((segment) => {
        const interval = segmentInterval(p, segment);
        return {
          ...interval,
          part: {
            kind: "video" as const,
            file: path.join(this.store.root, active(segment)!.file!),
            durationMs: interval.endTimeMs - interval.startTimeMs,
            transform: p.layerTransforms?.[segment.id],
          },
        };
      }),
      ...(p.videoClips ?? []).map((clip) => {
        const source = clipSource(p, clip);
        if (!source?.file) throw new Error("Arquivo do clipe desagrupado não encontrado.");
        return {
          startTimeMs: clip.startTimeMs,
          endTimeMs: clip.startTimeMs + clip.durationMs,
          part: {
            kind: "video" as const, file: path.join(this.store.root, source.file),
            durationMs: clip.durationMs, sourceStartMs: clip.sourceStartMs,
            transform: p.layerTransforms?.[clip.id],
          },
        };
      }),
      ...p.staticImageClips.map((clip) => ({
        startTimeMs: clip.startTimeMs,
        endTimeMs: clip.startTimeMs + clip.durationMs,
        part: {
          kind: "image" as const,
          file: path.join(
            this.store.root,
            p.media.find((m) => m.id === clip.mediaId)!.image,
          ),
          durationMs: clip.durationMs,
          transform: p.layerTransforms?.[clip.id],
        },
      })),
    ].sort((a, b) => a.startTimeMs - b.startTimeMs);
    const parts: CompositionPart[] = [];
    let cursor = 0;
    for (const item of placed) {
      if (item.startTimeMs > cursor)
        parts.push({ kind: "black", durationMs: item.startTimeMs - cursor });
      parts.push(item.part);
      cursor = item.endTimeMs;
    }
    if (cursor < timelineDurationMs(p))
      parts.push({
        kind: "black",
        durationMs: timelineDurationMs(p) - cursor,
      });
    const textClips = structuredClone(p.textClips ?? []);
    const layerTransforms = structuredClone(p.layerTransforms ?? {});
    p.jobs.push(job);
    this.store.save(p);
    this.enqueue(async () => {
      const file = `${pid}/${job.id}.mp4`;
      try {
        this.updateJob(pid, job.id, { status: "Generating" });
        await mkdir(path.join(this.store.root, pid), { recursive: true });
        await composeTimeline(
          parts,
          job.format,
          path.join(this.store.root, file),
          textClips,
          layerTransforms,
        );
        this.updateJob(pid, job.id, { status: "Completed", file });
      } catch (error) {
        console.error(`[${kind}]`, error);
        this.updateJob(pid, job.id, { status: "Failed", error: String(error) });
      }
    });
    return job;
  }
  private updateJob(pid: string, jid: string, patch: Partial<ExportJob>) {
    try {
      const p = this.store.get(pid);
      Object.assign(
        p.jobs.find((j) => j.id === jid)!,
        patch,
      );
      this.store.save(p);
    } catch (error) {
      console.error("[job persistence]", error);
    }
  }
}
