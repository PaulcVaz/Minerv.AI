import express from "express";
import { FalSettings } from "./fal-settings.ts";
import { validTransform } from "../shared/transform.ts";
import { defaultText, textOverlaps, textPositions, type TextClip } from "../shared/text.ts";
import multer from "multer";
import sharp from "sharp";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.ts";
import { Jobs } from "./jobs.ts";
import {
  createProject,
  id,
  reconcile,
  splitGeneratedSegment,
} from "./domain.ts";
import {
  DemoProvider,
  extractVideoFrame,
  ffmpeg,
  prepareImportedVideo,
  trimVideoRange,
} from "./media.ts";
import { existsSync } from "node:fs";
import {
  active,
  editorStructure,
  isImportedFrame,
  generatedChain,
  clipSource,
  type VideoClip,
  type Segment,
  type Generation,
  segmentImages,
  segmentInterval,
  timeline,
  timelineConflicts,
  videoPlacementError,
  type Project,
} from "../shared/types.ts";
export function createApp(
  root = path.resolve(process.env.STUDIO_DATA_DIR || "data"),
  falSettings = new FalSettings(),
) {
  const app = express(),
    store = new Store(root),
    jobs = new Jobs(store, new DemoProvider(path.resolve("assets/demo.mp4")), () => falSettings.value);
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      res.status(403).json({ error: "Local access only" });
      return;
    }
    const origin = req.get("origin");
    if (origin) {
      try {
        const u = new URL(origin);
        if (u.host !== req.get("host")) {
          res.status(403).json({ error: "Same-origin requests only" });
          return;
        }
      } catch {
        res.sendStatus(403);
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/settings/fal-key", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ configured: !!falSettings.value });
  });
  app.post("/api/settings/fal-key/reveal", (req, res) => {
    if (!req.is("application/json")) return res.sendStatus(415);
    res.set("Cache-Control", "no-store").json({ key: falSettings.value });
  });
  app.put("/api/settings/fal-key", (req, res) => {
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,256}:[A-Za-z0-9_-]{8,256}$/.test(key))
      throw new Error("Cole a chave completa da fal.ai.");
    try {
      falSettings.save(key);
    } catch {
      throw new Error("Não foi possível salvar a chave neste computador.");
    }
    res.set("Cache-Control", "no-store").json({ configured: true });
  });
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      ffmpeg: existsSync(ffmpeg),
      demo: existsSync("assets/demo.mp4"),
    }),
  );
  app.get("/api/projects", (_req, res) =>
    res.json(
      store.list().map(({ id, name, updatedAt, keyframes }) => ({
        id,
        name,
        updatedAt,
        count: keyframes.length,
        cover: keyframes[0]?.image,
      })),
    ),
  );
  app.get("/api/deletions", (_req, res) => res.json(store.pending()));
  app.post("/api/deletions", (req, res) => {
    const projectIds = req.body.projectIds;
    if (
      !Array.isArray(projectIds) ||
      projectIds.length < 1 ||
      projectIds.length > 100 ||
      projectIds.some((projectId) => typeof projectId !== "string") ||
      new Set(projectIds).size !== projectIds.length
    )
      throw new Error("Choose between 1 and 100 unique projects.");
    const projects = projectIds.map((projectId) => store.get(projectId));
    for (const project of projects) ensureProjectCanBeDeleted(project);
    res
      .status(202)
      .json(
        store.beginDeletions(
          projects.map((project) => ({ project, deletionId: id() })),
        ),
      );
  });
  app.post("/api/projects", (req, res) =>
    res.status(201).json(store.save(createProject(validName(req.body.name)))),
  );
  app.get("/api/projects/:id", (req, res) =>
    res.json(store.get(req.params.id)),
  );
  app.delete("/api/projects/:id", (req, res) => {
    const existing = store.pendingForProject(req.params.id);
    if (existing) {
      res.status(202).json(existing);
      return;
    }
    const p = store.get(req.params.id);
    ensureProjectCanBeDeleted(p);
    res.status(202).json(store.beginDeletion(p, id()));
  });
  app.post("/api/deletions/:id/undo", (req, res) => {
    const result = store.undoDeletion(req.params.id);
    if (result === "finalized")
      throw Object.assign(new Error("This deletion was already finalized."), {
        status: 409,
      });
    res.json({ ok: true, status: result });
  });
  app.delete("/api/deletions/:id", (req, res) => {
    const result = store.finalizeDeletion(req.params.id);
    res.json({ ok: true, status: result });
  });
  app.patch("/api/projects/:id", (req, res) => {
    const p = store.get(req.params.id);
    if (req.body.name !== undefined) p.name = validName(req.body.name);
    if (req.body.format) {
      const f = req.body.format;
      if (
        !["16:9", "9:16", "1:1"].includes(f.ratio) ||
        ![720, 1080].includes(f.resolution) ||
        ![24, 25, 30].includes(f.fps)
      )
        throw new Error("Invalid project format");
      p.format = { ratio: f.ratio, resolution: f.resolution, fps: f.fps };
    }
    if (req.body.selectedId !== undefined) p.selectedId = req.body.selectedId;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  });
  app.post(
    "/api/projects/:id/images",
    upload.array("images", 30),
    async (req, res) => {
      const initial = store.get(String(req.params.id));
      const files = req.files as Express.Multer.File[];
      if (!files?.length)
        throw new Error("Choose at least one JPG, PNG or WebP image.");
      const decoded = await Promise.all(
        files.map(async (f) => {
          const meta = await sharp(f.buffer, {
            limitInputPixels: 40000000,
          }).metadata();
          if (!["jpeg", "png", "webp"].includes(meta.format || ""))
            throw new Error("Only JPG, PNG and WebP images are supported.");
          return {
            id: id(),
            name: f.originalname,
            image: "",
            buffer: await sharp(f.buffer)
              .rotate()
              .resize({
                width: 3840,
                height: 3840,
                fit: "inside",
                withoutEnlargement: true,
              })
              .webp({ quality: 90 })
              .toBuffer(),
          };
        }),
      );
      await mkdir(path.join(root, initial.id), { recursive: true });
      for (const d of decoded) {
        d.image = `${initial.id}/${d.id}.webp`;
        await writeFile(path.join(root, d.image), d.buffer);
      }
      const p = store.get(initial.id);
      p.media.push(...decoded.map(({ buffer, ...asset }) => asset));
      res.json(store.save(p));
    },
  );
  const uploadVideo = multer({
    dest: tmpdir(),
    limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  });
  app.post("/api/projects/:id/videos", uploadVideo.single("video"), async (req, res) => {
    const upload = req.file;
    if (!upload) throw new Error("Selecione um vídeo MP4 ou MOV.");
    let staging: string | undefined;
    const published: string[] = [];
    let committed = false;
    try {
      if (!/\.(mp4|mov)$/i.test(upload.originalname))
        throw new Error("Selecione um vídeo MP4 ou MOV.");
      const initial = store.get(String(req.params.id));
      staging = await mkdtemp(path.join(root, ".video-import-"));
      const assetId = id();
      const files = [`${assetId}.mp4`, `${id()}.webp`, `${id()}.webp`];
      const [video, first, last] = files.map((file) => path.join(staging!, file));
      const durationMs = await prepareImportedVideo(upload.path, initial.format, video, first, last);
      const dir = path.join(root, initial.id);
      store.get(initial.id);
      await mkdir(dir, { recursive: true });
      for (const file of files) {
        const target = path.join(dir, file);
        await rename(path.join(staging, file), target);
        published.push(target);
      }
      const p = store.get(initial.id);
      const [file, firstImage, lastImage] = files.map((name) => `${p.id}/${name}`);
      (p.videos ??= []).push({
        id: assetId,
        name: upload.originalname.slice(0, 100),
        file, firstImage, lastImage, durationMs, format: initial.format,
      });
      store.save(p);
      committed = true;
      res.status(201).json(p);
    } finally {
      await rm(upload.path, { force: true });
      if (staging) await rm(staging, { recursive: true, force: true });
      if (!committed) await Promise.all(published.map((file) => rm(file, { force: true })));
    }
  });
  app.post("/api/projects/:id/videos/:vid/clips", (req, res) => {
    const p = store.get(req.params.id);
    const video = p.videos?.find((item) => item.id === req.params.vid);
    if (!video) throw new Error("Vídeo não encontrado na biblioteca.");
    const startTimeMs = validTime(req.body.startTimeMs, false);
    const endTimeMs = validTime(startTimeMs + video.durationMs, true);
    const error = videoPlacementError(p, video, startTimeMs);
    if (error) throw new Error(error);
    const boundaries = [
      { timeMs: startTimeMs, image: video.firstImage, name: "Início do vídeo" },
      { timeMs: endTimeMs, image: video.lastImage, name: "Fim do vídeo" },
    ];
    for (const [index, { timeMs, image }] of boundaries.entries()) {
      const keyframe = p.keyframes.find((k) => k.timeMs === timeMs);
      if (keyframe && keyframe.image !== image) {
        if (keyframe.image && req.body.boundaryImages?.[index] !== keyframe.image)
          throw Object.assign(new Error("Confirme a troca da imagem do keyframe na junção."), { status: 409 });
      }
    }
    const anchors = boundaries.map(({ timeMs, image, name }) => {
      const keyframe = p.keyframes.find((k) => k.timeMs === timeMs);
      if (!keyframe) {
        const created = { id: id(), timeMs, image, name };
        p.keyframes.push(created);
        return created;
      }
      keyframe.image = image;
      return keyframe;
    });
    reconcile(p);
    const segment = p.segments.find((s) => s.start === anchors[0].id && s.end === anchors[1].id)!;
    const generation = {
      id: id(), importedVideoId: video.id, status: "Completed" as const,
      settings: structuredClone(segment.settings), inputImages: segmentImages(p, segment),
      durationMs: video.durationMs, format: video.format, file: video.file,
      createdAt: new Date().toISOString(),
    };
    segment.generations.push(generation);
    segment.activeId = generation.id;
    p.selectedId = segment.id;
    res.status(201).json(store.save(p));
  });
  app.post("/api/projects/:id/keyframes", (req, res) => {
    const p = store.get(req.params.id);
    const timeMs = validTime(req.body.timeMs, false);
    assertOutsideImportedVideo(p, timeMs);
    if (p.keyframes.some((k) => k.timeMs === timeMs))
      throw new Error("A keyframe already exists here");
    const asset =
      req.body.mediaId == null
        ? undefined
        : p.media.find((m) => m.id === req.body.mediaId);
    if (req.body.mediaId != null && !asset)
      throw new Error("Media item not found");
    const importedFrame = req.body.importedFrame;
    if (importedFrame !== undefined && !isImportedFrame(p, importedFrame))
      throw new Error("Quadro de vídeo não encontrado.");
    const keyframe = {
      id: id(),
      name: validName(
        req.body.name ?? `Keyframe ${(timeMs / 1000).toFixed(3)}s`,
      ),
      timeMs,
      image: asset?.image ?? importedFrame,
    };
    p.keyframes.push(keyframe);
    reconcile(p);
    p.selectedId = keyframe.id;
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/structure", (req, res) => {
    const p = store.get(req.params.id);
    if (
      JSON.stringify(editorStructure(p)) !== JSON.stringify(req.body.expected)
    )
      throw Object.assign(
        new Error("Timeline changed in another editor. Refresh and try again."),
        { status: 409 },
      );
    const target = req.body.target;
    if (
      !Array.isArray(target?.keyframes) ||
      !Array.isArray(target?.staticImageClips) ||
      !Array.isArray(target?.importedClips) ||
      !Array.isArray(target?.textClips ?? [])
    )
      throw new Error("Invalid timeline structure");
    const knownImages = new Set(p.media.map((m) => m.image));
    for (const video of p.videos ?? []) {
      knownImages.add(video.firstImage);
      knownImages.add(video.lastImage);
    }
    for (const k of p.keyframes) if (k.image) knownImages.add(k.image);
    const ids = new Set<string>(),
      times = new Set<number>();
    p.keyframes = target.keyframes.map((k: any) => {
      if (typeof k.id !== "string" || ids.has(k.id))
        throw new Error("Invalid keyframe identity");
      ids.add(k.id);
      const timeMs = validTime(k.timeMs, false);
      if (times.has(timeMs)) throw new Error("Duplicate timestamp");
      times.add(timeMs);
      if (k.image && !knownImages.has(k.image))
        throw new Error("Unknown image");
      return {
        id: k.id,
        name: validName(k.name),
        timeMs,
        ...(k.image ? { image: k.image } : {}),
      };
    });
    p.staticImageClips = target.staticImageClips.map((c: any) => {
      if (
        typeof c.id !== "string" ||
        ids.has(c.id) ||
        !p.media.some((m) => m.id === c.mediaId)
      )
        throw new Error("Invalid clip");
      ids.add(c.id);
      return {
        id: c.id,
        mediaId: c.mediaId,
        startTimeMs: validTime(c.startTimeMs, false),
        durationMs: validTime(c.durationMs, true),
      };
    });
    const restoredTexts: TextClip[] = [];
    for (const raw of target.textClips ?? []) {
      if (typeof raw?.id !== "string" || !raw.id || ids.has(raw.id))
        throw new Error("Identificador de texto inválido.");
      ids.add(raw.id);
      const clip = validTextClip(raw, raw.id);
      checkTextPlacement(restoredTexts, clip);
      restoredTexts.push(clip);
    }
    p.textClips = restoredTexts;
    const detached = target.detachedSegments ?? [];
    if (!Array.isArray(detached) || detached.some((sid) => !p.segments.some((s) => s.id === sid)))
      throw new Error("Segmentos desagrupados inválidos.");
    const restoredVideos = target.videoClips ?? [];
    if (!Array.isArray(restoredVideos)) throw new Error("Clipes de vídeo inválidos.");
    p.videoClips = restoredVideos.map((raw) => {
      if (typeof raw?.id !== "string" || !raw.id || ids.has(raw.id))
        throw new Error("Identificador de vídeo inválido.");
      ids.add(raw.id);
      const clip = {
        id: raw.id, generationId: raw.generationId,
        startTimeMs: validTime(raw.startTimeMs, false),
        sourceStartMs: validTime(raw.sourceStartMs, false),
        durationMs: validTime(raw.durationMs, true),
      };
      const source = clipSource(p, clip);
      if (!source || clip.sourceStartMs + clip.durationMs > source.durationMs)
        throw new Error("Intervalo de vídeo inválido.");
      return clip;
    });
    for (const segment of p.segments) segment.detached = detached.includes(segment.id);
    const transforms = target.layerTransforms ?? {};
    if (typeof transforms !== "object" || Array.isArray(transforms) ||
        !Object.values(transforms).every(validTransform))
      throw new Error("Transformações da timeline inválidas.");
    p.layerTransforms = transforms;
    reconcile(p);
    const importedClips = new Map<string, string>();
    for (const { segmentId, generationId } of target.importedClips) {
      const segment = timeline(p).find((s) => s.id === segmentId);
      const generation = segment?.generations.find((g) => g.id === generationId);
      if (!segment || !generation?.importedVideoId || generation.status !== "Completed" ||
          importedClips.has(segmentId) ||
          (active({ ...segment, detached: false }) && !active({ ...segment, detached: false })?.importedVideoId) ||
          segment.generations.some((g) => g.status === "Queued" || g.status === "Generating"))
        throw new Error("O segmento importado mudou. Atualize a timeline e tente novamente.");
      importedClips.set(segmentId, generationId);
    }
    for (const segment of timeline(p)) {
      if (importedClips.has(segment.id) || active({ ...segment, detached: false })?.importedVideoId)
        segment.activeId = importedClips.get(segment.id);
    }
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/text-clips", (req, res) => {
    const p = store.get(req.params.id);
    const clip = validTextClip({ ...defaultText, ...req.body }, id());
    const clips = p.textClips ?? [];
    checkTextPlacement(clips, clip);
    p.textClips = [...clips, clip];
    p.selectedId = clip.id;
    res.status(201).json(store.save(p));
  });
  app.patch("/api/projects/:id/layer-transforms/:lid", (req, res) => {
    const p = store.get(req.params.id);
    const layerId = req.params.lid;
    if (!(p.textClips?.some((clip) => clip.id === layerId) ||
          p.videoClips?.some((clip) => clip.id === layerId) ||
          p.staticImageClips.some((clip) => clip.id === layerId) ||
          timeline(p).some((segment) => segment.id === layerId && !!active(segment)?.file)))
      throw new Error("Elemento da prévia não encontrado.");
    if (!validTransform(req.body)) throw new Error("Transformação inválida.");
    const { x, y, scale, rotation } = req.body;
    p.layerTransforms = { ...p.layerTransforms, [layerId]: { x, y, scale, rotation } };
    p.selectedId = layerId;
    res.json(store.save(p));
  });
  app.patch("/api/projects/:id/text-clips/:tid", (req, res) => {
    const p = store.get(req.params.id);
    const clips = p.textClips ?? [];
    const current = clips.find((clip) => clip.id === req.params.tid);
    if (!current) throw new Error("Texto não encontrado.");
    const clip = validTextClip({ ...current, ...req.body }, current.id);
    checkTextPlacement(clips, clip);
    p.textClips = clips.map((item) => item.id === clip.id ? clip : item);
    p.selectedId = clip.id;
    res.json(store.save(p));
  });
  app.delete("/api/projects/:id/text-clips/:tid", (req, res) => {
    const p = store.get(req.params.id);
    const clips = p.textClips ?? [];
    p.textClips = clips.filter((clip) => clip.id !== req.params.tid);
    if (clips.length === p.textClips.length) throw new Error("Texto não encontrado.");
    if (p.selectedId === req.params.tid) p.selectedId = null;
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/media/:mid/keyframes", (req, res) => {
    const p = store.get(req.params.id);
    const asset = p.media.find((item) => item.id === req.params.mid);
    if (!asset) throw new Error("Media item not found");
    const timeMs = validTime(req.body.timeMs, false);
    assertOutsideImportedVideo(p, timeMs);
    if (p.keyframes.some((k) => k.timeMs === timeMs))
      throw new Error("A keyframe already exists at this timestamp.");
    const keyframe = { ...asset, id: id(), timeMs };
    p.keyframes.push(keyframe);
    reconcile(p);
    p.selectedId = keyframe.id;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.post("/api/projects/:id/media/:mid/static-clips", (req, res) => {
    const p = store.get(req.params.id);
    if (!p.media.some((item) => item.id === req.params.mid))
      throw new Error("Media item not found");
    const clip = {
      id: id(),
      mediaId: req.params.mid,
      startTimeMs: validTime(req.body.startTimeMs, false),
      durationMs: validTime(req.body.durationMs ?? 4000, true),
    };
    p.staticImageClips.push(clip);
    p.selectedId = clip.id;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.delete("/api/projects/:id/keyframes/:kid", (req, res) => {
    const p = store.get(req.params.id);
    assertImportedBoundaryEditable(p, req.params.kid);
    p.keyframes = p.keyframes.filter((k) => k.id !== req.params.kid);
    reconcile(p);
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.patch("/api/projects/:id/keyframes/:kid", (req, res) => {
    const p = store.get(req.params.id);
    const keyframe = p.keyframes.find((k) => k.id === req.params.kid);
    if (!keyframe) throw new Error("Keyframe not found");
    const timeMs =
      req.body.timeMs === undefined
        ? keyframe.timeMs
        : validTime(req.body.timeMs, false);
    if (timeMs !== keyframe.timeMs || req.body.mediaId !== undefined || req.body.image === null)
      assertImportedBoundaryEditable(p, keyframe.id);
    assertOutsideImportedVideo(p, timeMs);
    if (p.keyframes.some((k) => k.id !== keyframe.id && k.timeMs === timeMs))
      throw new Error("A keyframe already exists at this timestamp.");
    keyframe.timeMs = timeMs;
    if (req.body.name !== undefined) keyframe.name = validName(req.body.name);
    if (req.body.mediaId !== undefined || req.body.image === null) {
      const asset =
        req.body.mediaId == null
          ? undefined
          : p.media.find((m) => m.id === req.body.mediaId);
      if (req.body.mediaId != null && !asset)
        throw new Error("Media item not found");
      keyframe.image = asset?.image;
    }
    reconcile(p);
    p.selectedId = keyframe.id;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.patch("/api/projects/:id/segments/:sid/move", (req, res) => {
    const p = store.get(req.params.id);
    const chain = generatedChain(p, req.params.sid);
    if (!chain.segments.length)
      throw new Error("Active generated segment not found");
    const requestedDelta = Number(req.body.deltaMs);
    if (!Number.isInteger(requestedDelta))
      throw new Error("Timeline delta must be a whole number of milliseconds.");
    const deltaMs = Math.max(requestedDelta, -chain.keyframes[0].timeMs);
    const movedIds = new Set(chain.keyframes.map((k) => k.id));
    const positions = chain.keyframes.map((k) => k.timeMs + deltaMs);
    for (const timeMs of positions) assertOutsideImportedVideo(p, timeMs, movedIds);
    const targets = new Set(positions);
    if (p.keyframes.some((k) => !movedIds.has(k.id) && targets.has(k.timeMs)))
      throw new Error("A keyframe already exists at the target timestamp.");
    const firstTarget = positions[0],
      lastTarget = positions.at(-1)!;
    if (
      p.keyframes.some(
        (k) =>
          !movedIds.has(k.id) &&
          k.timeMs > firstTarget &&
          k.timeMs < lastTarget,
      )
    )
      throw new Error("A generated chain cannot contain an external keyframe.");
    chain.keyframes.forEach((keyframe, index) => {
      keyframe.timeMs = positions[index];
    });
    reconcile(p);
    p.selectedId = req.params.sid;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.post("/api/projects/:id/segments/:sid/detach", (req, res) => {
    const p = store.get(req.params.id);
    const segment = timeline(p).find((item) => item.id === req.params.sid);
    const generation = segment && active(segment);
    if (!segment || !generation?.file) throw new Error("Selecione um vídeo ativo.");
    if (segment.generations.some((g) => g.status === "Queued" || g.status === "Generating"))
      throw new Error("Aguarde a geração em andamento.");
    const clip = independentClip(p, segment, generation);
    const pieces = req.body?.cutTimeMs === undefined ? [clip] : cutVideoClip(clip, req.body.cutTimeMs);
    segment.detached = true;
    p.videoClips = [...(p.videoClips ?? []), ...pieces];
    const transform = p.layerTransforms?.[segment.id];
    if (transform) for (const piece of pieces) (p.layerTransforms ??= {})[piece.id] = transform;
    p.selectedId = pieces.at(-1)!.id;
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/video-clips/join", (req, res) => {
    const p = store.get(req.params.id);
    const ids = req.body?.clipIds;
    if (!Array.isArray(ids) || ids.length !== 2 ||
        !ids.every((value) => typeof value === "string") || ids[0] === ids[1])
      throw new Error("Selecione dois clipes de vídeo.");
    const videos = [
      ...(p.videoClips ?? []).map((clip) => ({
        id: clip.id, clip, startTimeMs: clip.startTimeMs,
        endTimeMs: clip.startTimeMs + clip.durationMs,
        segment: undefined,
      })),
      ...timeline(p).flatMap((segment) => {
        const generation = active(segment);
        if (!generation?.file) return [];
        return [{ id: segment.id, clip: undefined, segment, ...segmentInterval(p, segment) }];
      }),
    ];
    const pair = videos.filter((video) => ids.includes(video.id))
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
    if (pair.length !== 2) throw new Error("Selecione dois clipes de vídeo.");
    const [left, right] = pair;
    if (left.endTimeMs > right.startTimeMs ||
        videos.some((video) => !ids.includes(video.id) &&
          video.startTimeMs < right.startTimeMs && video.endTimeMs > left.endTimeMs) ||
        p.staticImageClips.some((clip) => clip.startTimeMs < right.startTimeMs &&
          clip.startTimeMs + clip.durationMs > left.endTimeMs))
      throw new Error("Selecione dois vídeos consecutivos sem sobreposição ou mídia entre eles.");
    if (left.endTimeMs === right.startTimeMs) return res.json(p);
    if (right.segment?.generations.some((g) => g.status === "Queued" || g.status === "Generating"))
      throw new Error("Aguarde a geração em andamento.");
    const clip = right.clip ?? independentClip(p, right.segment!, active(right.segment!)!);
    if (right.segment) {
      right.segment.detached = true;
      (p.videoClips ??= []).push(clip);
      const transform = p.layerTransforms?.[right.id];
      if (transform) (p.layerTransforms ??= {})[clip.id] = transform;
    }
    clip.startTimeMs = left.endTimeMs;
    if (timelineConflicts(p).some((conflict) => conflict.itemIds.includes(clip.id)))
      throw new Error("A união sobrepõe outro vídeo ou imagem.");
    p.selectedId = clip.id;
    res.json(store.save(p));
  });
  app.patch("/api/projects/:id/video-clips/:cid", (req, res) => {
    const p = store.get(req.params.id);
    const clip = p.videoClips?.find((item) => item.id === req.params.cid);
    if (!clip) throw new Error("Clipe de vídeo não encontrado.");
    clip.startTimeMs = validTime(req.body.startTimeMs, false);
    if (timelineConflicts(p).some((conflict) => conflict.itemIds.includes(clip.id)))
      throw new Error("Escolha um espaço sem outro vídeo ou imagem.");
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/video-clips/:cid/split", (req, res) => {
    const p = store.get(req.params.id);
    const clip = p.videoClips?.find((item) => item.id === req.params.cid);
    if (!clip) throw new Error("Clipe de vídeo não encontrado.");
    const [left, right] = cutVideoClip(clip, req.body.timeMs);
    p.videoClips = p.videoClips!.flatMap((item) => item.id === clip.id ? [left, right] : [item]);
    const transform = p.layerTransforms?.[clip.id];
    if (transform) (p.layerTransforms ??= {})[right.id] = transform;
    p.selectedId = right.id;
    res.json(store.save(p));
  });
  app.delete("/api/projects/:id/video-clips/:cid", (req, res) => {
    const p = store.get(req.params.id);
    p.videoClips = (p.videoClips ?? []).filter((clip) => clip.id !== req.params.cid);
    if (p.selectedId === req.params.cid) p.selectedId = null;
    if (p.layerTransforms) delete p.layerTransforms[req.params.cid];
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/segments/:sid/keyframes", async (req, res) => {
    const initial = store.get(req.params.id);
    const timeMs = validTime(req.body.timeMs, false);
    const original = timeline(initial).find(
      (segment) => segment.id === req.params.sid,
    );
    if (!original) throw new Error("Select a current segment.");
    const generation = active(original);
    if (!generation?.file) throw new Error("Generate this segment first.");
    const interval = segmentInterval(initial, original);
    const offsetMs = timeMs - interval.startTimeMs;
    const operationId = id();
    const frameFile = `${initial.id}/${operationId}.webp`;
    const leftFile = `${initial.id}/${id()}.mp4`;
    const rightFile = `${initial.id}/${id()}.mp4`;
    const result = splitGeneratedSegment(initial, original.id, timeMs, {
      frame: frameFile,
      leftVideo: leftFile,
      rightVideo: rightFile,
    });
    const directory = path.join(root, initial.id);
    const sourceFile = path.join(root, generation.file);
    if (!existsSync(sourceFile))
      throw new Error("Generated video file is missing.");
    await mkdir(directory, { recursive: true });
    const finalFiles = [frameFile, leftFile, rightFile].map((file) =>
      path.join(root, file),
    );
    const temporaryFiles = [
      `${finalFiles[0]}.split-${operationId}.webp`,
      `${finalFiles[1]}.split-${operationId}.mp4`,
      `${finalFiles[2]}.split-${operationId}.mp4`,
    ];
    let committed = false;
    try {
      await extractVideoFrame(
        sourceFile,
        offsetMs,
        generation.format,
        temporaryFiles[0],
      );
      await trimVideoRange(
        sourceFile,
        0,
        offsetMs,
        generation.format,
        temporaryFiles[1],
      );
      await trimVideoRange(
        sourceFile,
        offsetMs,
        generation.durationMs - offsetMs,
        generation.format,
        temporaryFiles[2],
      );
      if (store.get(initial.id).revision !== initial.revision)
        throw Object.assign(
          new Error(
            "The project changed while the keyframe was being created.",
          ),
          { status: 409 },
        );
      for (let index = 0; index < finalFiles.length; index++)
        await rename(temporaryFiles[index], finalFiles[index]);
      if (store.get(initial.id).revision !== initial.revision)
        throw Object.assign(
          new Error(
            "The project changed while the keyframe was being created.",
          ),
          { status: 409 },
        );
      store.save(result.project);
      committed = true;
    } finally {
      if (!committed)
        await Promise.all(
          [...temporaryFiles, ...finalFiles].map((file) =>
            rm(file, { force: true }),
          ),
        );
    }
    jobs.ensurePreview(initial.id);
    res.json(store.get(initial.id));
  });
  app.delete("/api/projects/:id/segments/:sid/active", (req, res) => {
    const p = store.get(req.params.id);
    const segment = timeline(p).find((item) => item.id === req.params.sid);
    if (!segment) throw new Error("Select a current segment.");
    segment.activeId = undefined;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.patch("/api/projects/:id/static-clips/:cid", (req, res) => {
    const p = store.get(req.params.id);
    const clip = p.staticImageClips.find((c) => c.id === req.params.cid);
    if (!clip) throw new Error("Static image clip not found");
    if (req.body.startTimeMs !== undefined)
      clip.startTimeMs = validTime(req.body.startTimeMs, false);
    if (req.body.durationMs !== undefined)
      clip.durationMs = validTime(req.body.durationMs, true);
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.delete("/api/projects/:id/static-clips/:cid", (req, res) => {
    const p = store.get(req.params.id);
    if (!p.staticImageClips.some((c) => c.id === req.params.cid))
      throw new Error("Static image clip not found");
    p.staticImageClips = p.staticImageClips.filter(
      (c) => c.id !== req.params.cid,
    );
    if (p.selectedId === req.params.cid) p.selectedId = null;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.patch("/api/projects/:id/segments/:sid", (req, res) => {
    const p = store.get(req.params.id),
      s = timeline(p).find((s) => s.id === req.params.sid);
    if (!s) throw new Error("Segment not found");
    const next = { ...s.settings, ...req.body };
    if (
      typeof next.prompt !== "string" ||
      next.prompt.length > 4000 ||
      !["Continuous", "Neutral", "Cut"].includes(next.continuity) ||
      !["Demo", "Kling V3", "Seedance 2.5"].includes(next.model) ||
      typeof next.seed !== "string" ||
      !/^\d{0,16}$/.test(next.seed)
    )
      throw new Error("Check prompt, continuity and seed (up to 16 digits).");
    s.settings = {
      prompt: next.prompt,
      continuity: next.continuity,
      model: next.model,
      seed: next.seed,
    };
    res.json(store.save(p));
  });
  app.post("/api/projects/:id/segments/:sid/generate", (req, res) => {
    jobs.generate(req.params.id, req.params.sid);
    res.status(202).json(store.get(req.params.id));
  });
  app.post("/api/projects/:id/segments/:sid/replace-actor", (req, res) => {
    jobs.replaceActor(req.params.id, req.params.sid, req.body.mediaId);
    res.status(202).json(store.get(req.params.id));
  });
  app.put("/api/projects/:id/segments/:sid/active", (req, res) => {
    const p = store.get(req.params.id),
      s = p.segments.find((s) => s.id === req.params.sid);
    if (
      !s?.generations.some(
        (g) => g.id === req.body.generationId && g.status === "Completed",
      )
    )
      throw new Error("Choose a completed version.");
    s.activeId = req.body.generationId;
    store.save(p);
    jobs.ensurePreview(p.id);
    res.json(store.get(p.id));
  });
  app.post("/api/projects/:id/preview", (req, res) => {
    res.status(202).json(store.get(req.params.id));
  });
  app.post("/api/projects/:id/export", (req, res) => {
    ensureComposable(store.get(req.params.id));
    jobs.compose(req.params.id, "export");
    res.status(202).json(store.get(req.params.id));
  });
  app.get("/api/projects/:id/exports/:jid/download", (req, res) => {
    const p = store.get(req.params.id),
      j = p.jobs.find(
        (j) =>
          j.id === req.params.jid &&
          j.kind === "export" &&
          j.status === "Completed",
      );
    if (!j?.file) throw new Error("Export is not ready");
    res.download(
      path.join(root, j.file),
      p.name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".mp4",
    );
  });
  app.use(
    "/media",
    (req, res, next) => {
      if (
        !/^\/[0-9a-f-]{36}\/[0-9a-f-]{36}(?:-left|-right)?\.(mp4|webp)$/.test(
          req.path,
        )
      ) {
        res.sendStatus(404);
        return;
      }
      next();
    },
    express.static(root, {
      dotfiles: "deny",
      index: false,
      setHeaders(res) {
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found" }),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[request]", err);
      res
        .status(err.status || 400)
        .json({
          error: err.code === "LIMIT_FILE_SIZE" && _req.path.endsWith("/videos")
            ? "Importe um vídeo de até 250 MB."
            : err.message || "Operation failed. Please retry.",
        });
    },
  );
  return { app, store, jobs };
}
function validName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
    throw new Error("Enter a project name of 1–100 characters.");
  return value.trim();
}
function assertImportedBoundaryEditable(p: Project, keyframeId: string) {
  if (timeline(p).some((s) => (s.start === keyframeId || s.end === keyframeId) && active(s)?.importedVideoId))
    throw new Error("Este keyframe pertence a um vídeo importado. Mova o clipe inteiro ou remova-o para editar a borda.");
}
function assertOutsideImportedVideo(p: Project, timeMs: number, moving = new Set<string>()) {
  if (timeline(p).some((s) => {
    if (!active(s)?.importedVideoId || moving.has(s.start)) return false;
    const { startTimeMs, endTimeMs } = segmentInterval(p, s);
    return timeMs > startTimeMs && timeMs < endTimeMs;
  })) throw new Error("Use Extrair keyframe para dividir um vídeo importado.");
}
function validTime(value: unknown, positive: boolean) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (positive ? number <= 0 : number < 0))
    throw new Error(
      positive
        ? "Duration must be a positive whole number of milliseconds."
        : "Time must be a non-negative whole number of milliseconds.",
    );
  return number;
}
function validTextClip(raw: Record<string, unknown>, id: string): TextClip {
  const { startTimeMs, durationMs, content, size, color, position } = raw;
  if (typeof startTimeMs !== "number" || !Number.isSafeInteger(startTimeMs) || startTimeMs < 0 ||
      typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 100 ||
      startTimeMs + durationMs > 86_400_000)
    throw new Error("Use início e duração válidos. O texto deve durar pelo menos 0,1 s.");
  const normalized = typeof content === "string" ? content.replace(/\r\n?/g, "\n") : "";
  if (!normalized.trim() || normalized.length > 500 || normalized.split("\n").length > 8 ||
      /[\x00-\x08\x0b-\x1f\ufffe\uffff]/.test(normalized))
    throw new Error("Use de 1 a 500 caracteres, em até 8 linhas.");
  if (typeof size !== "number" || !Number.isInteger(size) || size < 12 || size > 160 ||
      typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color) ||
      !textPositions.includes(position as TextClip["position"]))
    throw new Error("Tamanho, cor ou posição do texto inválidos.");
  return { id, startTimeMs, durationMs, content: normalized, size, color, position: position as TextClip["position"] };
}

function checkTextPlacement(clips: TextClip[], clip: TextClip) {
  if (textOverlaps(clips, clip))
    throw Object.assign(new Error("Já existe texto neste intervalo."), { status: 409 });
  if (clips.length >= 100 && !clips.some((item) => item.id === clip.id))
    throw new Error("O projeto aceita até 100 clipes de texto.");
}

function independentClip(p: Project, segment: Segment, generation: Generation): VideoClip {
  const { startTimeMs, endTimeMs } = segmentInterval(p, segment);
  return {
    id: id(), generationId: generation.id, startTimeMs, sourceStartMs: 0,
    durationMs: Math.min(endTimeMs - startTimeMs, generation.durationMs),
  };
}

function cutVideoClip(clip: VideoClip, value: unknown): [VideoClip, VideoClip] {
  const timeMs = validTime(value, false);
  const offset = timeMs - clip.startTimeMs;
  if (offset <= 0 || offset >= clip.durationMs)
    throw new Error("Posicione a agulha dentro do clipe para cortar.");
  return [
    { ...clip, durationMs: offset },
    { ...clip, id: id(), startTimeMs: timeMs, sourceStartMs: clip.sourceStartMs + offset,
      durationMs: clip.durationMs - offset },
  ];
}

function ensureComposable(project: ReturnType<Store["get"]>) {
  const conflicts = timelineConflicts(project);
  if (conflicts.length) {
    const first = conflicts[0];
    throw Object.assign(
      new Error(
        `Resolve timeline overlap from ${(first.startTimeMs / 1000).toFixed(1)}s to ${(first.endTimeMs / 1000).toFixed(1)}s before export.`,
      ),
      { status: 409 },
    );
  }
}
function ensureProjectCanBeDeleted(project: ReturnType<Store["get"]>) {
  if (
    [...project.jobs, ...project.segments.flatMap((s) => s.generations)].some(
      (job) => job.status === "Queued" || job.status === "Generating",
    )
  )
    throw new Error("Wait for running jobs before deleting this project.");
}
