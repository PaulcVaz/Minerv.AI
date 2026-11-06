import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { textSvg, type TextClip } from "../shared/text.ts";
import { type LayerTransform } from "../shared/transform.ts";
import { createFalClient } from "@fal-ai/client";
import { readFile } from "node:fs/promises";
import { dimensions, klingDurationSeconds, type Format, type Settings } from "../shared/types.ts";
export const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
function execute(args: string[], binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { windowsHide: true },
    );
    let error = "";
    let progress = "";
    child.stdout.on("data", (d) => { progress = (progress + d.toString()).slice(-8000); });
    child.stderr.on("data", (d) => {
      error = (error + d.toString()).slice(-8000);
    });
    child.on("error", (e) =>
      reject(
        new Error(
          `FFmpeg unavailable: ${e.message}. Install dependencies or set FFMPEG_PATH.`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(progress)
        : reject(new Error(`FFmpeg failed (${code}): ${error}`)),
    );
  });
}
export async function run(args: string[], binary = ffmpeg): Promise<void> {
  await execute(args, binary);
}
export function filter(f: Format) {
  const [w, h] = dimensions(f);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${f.fps},format=yuv420p`;
}
export const encoding = [
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-crf",
  "23",
  "-threads",
  "2",
  "-movflags",
  "+faststart",
];
const audioEncoding = ["-c:a", "aac", "-ar", "48000", "-ac", "2"];

export async function prepareImportedVideo(
  input: string, format: Format, video: string, first: string, last: string,
) {
  const progress = await execute([
    "-i", input, "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", filter(format), ...encoding, ...audioEncoding,
    "-progress", "pipe:1", video,
  ], ffmpeg);
  const frames = Number([...progress.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);
  if (!frames) throw new Error("O vídeo importado não contém frames reproduzíveis.");
  await extractVideoFrame(video, 0, format, first);
  await extractVideoFrame(video, Math.floor((frames - 1) * 1000 / format.fps), format, last);
  return Math.round(frames * 1000 / format.fps);
}
export async function extractVideoFrame(
  input: string,
  offsetMs: number,
  format: Format,
  outputWebp: string,
) {
  const [width, height] = dimensions(format);
  await run([
    "-i",
    input,
    "-ss",
    String(offsetMs / 1000),
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-quality",
    "90",
    outputWebp,
  ]);
}
export async function trimVideoRange(
  input: string,
  startMs: number,
  durationMs: number,
  format: Format,
  outputMp4: string,
) {
  await run([
    "-i",
    input,
    "-ss",
    String(startMs / 1000),
    "-t",
    String(durationMs / 1000),
    "-vf",
    filter(format),
    "-map", "0:v:0", "-map", "0:a:0?",
    ...encoding,
    ...audioEncoding,
    outputMp4,
  ]);
}
export interface GenerationInput {
  startImage?: string;
  endImage?: string;
  settings: Settings;
  durationMs: number;
  format: Format;
  output: string;
}
export interface GenerationProvider {
  generate(input: GenerationInput): Promise<void>;
  replaceActor?(input: { video: string; actorImage: string; format: Format; durationMs: number; output: string }): Promise<void>;
}
async function downloadVideo(url: string, output: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`AI video download failed (${response.status}).`);
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
}
export class FalProvider implements GenerationProvider {
  private client;
  constructor(key: string) {
    this.client = createFalClient({ credentials: key });
  }
  private async upload(file: string, mime: string) {
    const bytes = await readFile(file);
    return this.client.storage.upload(new File([bytes], path.basename(file), { type: mime }));
  }
  async generate(input: GenerationInput) {
    if (input.settings.model !== "Kling V3")
      throw new Error("A geração com Seedance 2.5 está indisponível nesta versão.");
    if (!input.startImage) throw new Error("Kling V3 requires an image on the first keyframe.");
    const seconds = klingDurationSeconds(input.durationMs);
    if (seconds === undefined)
      throw new Error("Kling V3 segments must last 3–15 seconds.");
    const start_image_url = await this.upload(input.startImage, "image/webp");
    const end_image_url = input.endImage ? await this.upload(input.endImage, "image/webp") : undefined;
    const result = await this.client.subscribe("fal-ai/kling-video/v3/standard/image-to-video", {
      input: { start_image_url, ...(end_image_url ? { end_image_url } : {}), prompt: input.settings.prompt || "Natural cinematic motion", duration: String(seconds) as "3", generate_audio: false },
    });
    const url = (result.data as { video?: { url?: string } }).video?.url;
    if (!url) throw new Error("AI provider returned no video.");
    const raw = input.output + ".source.mp4";
    try {
      await downloadVideo(url, raw);
      await run([
        "-i", raw,
        "-vf", `setpts=${input.durationMs / (seconds * 1000)}*(PTS-STARTPTS),${filter(input.format)}`,
        "-t", String(input.durationMs / 1000),
        "-an", ...encoding, input.output,
      ]);
    } finally { await rm(raw, { force: true }); }
  }
  async replaceActor(input: { video: string; actorImage: string; format: Format; durationMs: number; output: string }) {
    const video_url = await this.upload(input.video, "video/mp4");
    const image_url = await this.upload(input.actorImage, "image/webp");
    const result = await this.client.subscribe("fal-ai/wan/v2.2-14b/animate/replace", {
      input: { video_url, image_url, resolution: "720p" },
    });
    const url = (result.data as { video?: { url?: string } }).video?.url;
    if (!url) throw new Error("Actor replacement returned no video.");
    const raw = input.output + ".source.mp4";
    try {
      await downloadVideo(url, raw);
      await trimVideoRange(raw, 0, input.durationMs, input.format, input.output);
    } finally { await rm(raw, { force: true }); }
  }
}
export class DemoProvider implements GenerationProvider {
  constructor(private clip: string) {}
  async generate(input: GenerationInput) {
    if (!existsSync(this.clip))
      throw new Error("Demo clip missing. Run the demo setup command.");
    await run([
      "-stream_loop",
      "-1",
      "-i",
      this.clip,
      "-t",
      String(input.durationMs / 1000),
      "-vf",
      filter(input.format),
      "-an",
      ...encoding,
      input.output,
    ]);
  }
}
export async function concatenate(
  files: string[],
  format: Format,
  output: string,
) {
  const folder = output + ".parts";
  await mkdir(folder, { recursive: true });
  try {
    const parts: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const part = path.join(folder, `${i}.mp4`);
      await run(["-i", files[i], "-vf", filter(format), "-an", ...encoding, part]);
      parts.push(part);
    }
    const list = path.join(folder, "list.txt");
    await writeFile(
      list,
      parts
        .map(
          (f) => `file '${f.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
        )
        .join("\n"),
    );
    await run([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
export type CompositionPart = (
  | { kind: "video"; file: string; durationMs: number; sourceStartMs?: number }
  | { kind: "image"; file: string; durationMs: number }
  | { kind: "black"; durationMs: number }
) & { transform?: LayerTransform };
async function hasAudio(file: string) {
  try {
    await run(["-i", file, "-map", "0:a:0", "-t", "0", "-f", "null", "-"]);
    return true;
  } catch (error) {
    if (String(error).includes("Stream map '0:a:0' matches no streams")) return false;
    throw error;
  }
}
export async function composeTimeline(
  inputs: CompositionPart[],
  format: Format,
  output: string,
  textClips: readonly TextClip[] = [],
  layerTransforms: Record<string, LayerTransform> = {},
) {
  const folder = output + ".parts";
  await mkdir(folder, { recursive: true });
  try {
    const parts: string[] = [];
    const [width, height] = dimensions(format);
    const overlays = await Promise.all(textClips.map(async (clip, index) => {
      const file = path.join(folder, `text-${index}.png`);
      await sharp(Buffer.from(textSvg(clip, format, layerTransforms[clip.id]))).png().toFile(file);
      return { clip, file };
    }));
    let cursor = 0;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const part = path.join(folder, `${i}.mp4`);
      const end = cursor + input.durationMs;
      const frames = Math.round(end * format.fps / 1000) - Math.round(cursor * format.fps / 1000);
      if (frames === 0) {
        cursor = end;
        continue;
      }
      const seconds = String(frames / format.fps);
      const videoInput = input.kind === "black"
        ? ["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${format.fps}`]
        : [
            ...(input.kind === "image" ? ["-loop", "1"] : []),
            ...(input.kind === "video" && input.sourceStartMs ? ["-ss", String(input.sourceStartMs / 1000)] : []),
            "-i", input.file,
          ];
      const withAudio = input.kind === "video" && await hasAudio(input.file);
      const audioInput = withAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
      const activeOverlays = overlays.filter(({ clip }) =>
        clip.startTimeMs < cursor + input.durationMs && clip.startTimeMs + clip.durationMs > cursor,
      );
      const t = input.transform;
      const rotation = t ? `${t.rotation}*PI/180` : "";
      const base = t ? [
        `[0:v]${filter(format)},setsar=1,split[base][layer]`,
        "[base]drawbox=color=black:t=fill[background]",
        `[layer]scale=${Math.max(2, Math.round(width * t.scale / 2) * 2)}:${Math.max(2, Math.round(height * t.scale / 2) * 2)},setsar=1,format=rgba,rotate=${rotation}:ow=rotw(${rotation}):oh=roth(${rotation}):c=none[foreground]`,
        `[background][foreground]overlay=x=(W-w)/2+${t.x * width}:y=(H-h)/2+${t.y * height}[v0]`,
      ] : [`[0:v]${filter(format)}[v0]`];
      const videoFilter = activeOverlays.length || t ? [
        "-filter_complex_threads", "1", "-filter_complex",
        [
          ...base,
          ...activeOverlays.map(({ clip }, index) => {
            const start = Math.max(0, (clip.startTimeMs - cursor) / 1000);
            const end = (clip.startTimeMs + clip.durationMs - cursor) / 1000;
            const overlayInput = index + (withAudio ? 1 : 2);
            return `[v${index}][${overlayInput}:v]overlay=enable='gte(t,${start})*lt(t,${end})'[v${index + 1}]`;
          }),
        ].join(";"),
        "-map", `[v${activeOverlays.length}]`,
      ] : ["-vf", filter(format), "-map", "0:v:0"];
      await run([
        ...videoInput,
        ...audioInput,
        ...activeOverlays.flatMap(({ file }) => ["-i", file]),
        ...videoFilter,
        "-map", withAudio ? "0:a:0" : "1:a:0",
        "-t", seconds, "-af", "apad",
        ...encoding, ...audioEncoding, part,
      ]);
      parts.push(part);
      cursor = end;
    }
    const list = path.join(folder, "list.txt");
    await writeFile(
      list,
      parts
        .map(
          (f) => `file '${f.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
        )
        .join("\n"),
    );
    await run([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
