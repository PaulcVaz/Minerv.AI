import { dimensions, type Format } from "./types.ts";
import { identityTransform, type LayerTransform } from "./transform.ts";

export const textPositions = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export interface TextClip {
  id: string;
  startTimeMs: number;
  durationMs: number;
  content: string;
  size: number;
  color: string;
  position: (typeof textPositions)[number];
}

export const defaultText = {
  durationMs: 3000,
  content: "Seu texto aqui",
  size: 48,
  color: "#ffffff",
  position: "bottom-center",
} satisfies Omit<TextClip, "id" | "startTimeMs">;

export function textOverlaps(
  clips: readonly TextClip[],
  candidate: Pick<TextClip, "id" | "startTimeMs" | "durationMs">,
) {
  return clips.some(
    (clip) =>
      clip.id !== candidate.id &&
      clip.startTimeMs < candidate.startTimeMs + candidate.durationMs &&
      candidate.startTimeMs < clip.startTimeMs + clip.durationMs,
  );
}

export function textAt(clips: readonly TextClip[], timeMs: number) {
  return clips.find(
    (clip) =>
      timeMs >= clip.startTimeMs && timeMs < clip.startTimeMs + clip.durationMs,
  );
}

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// The browser and FFmpeg use the same full-frame artwork and safe margins.
export function textLayout(clip: TextClip, format: Format) {
  const [width, height] = dimensions(format);
  const lines = clip.content.split("\n");
  const [vertical, horizontal] = clip.position.split("-");
  const marginX = width * 0.06,
    marginY = height * 0.06;
  const longest = Math.max(1, ...lines.map((line) => Array.from(line).length));
  const fontSize = Math.min(
    (clip.size * Math.min(width, height)) / 720,
    (width - 2 * marginX) / (longest * 0.75),
    (height - 2 * marginY) / (lines.length * 1.25),
  );
  const lineHeight = fontSize * 1.25;
  const blockHeight = lineHeight * lines.length;
  const y =
    vertical === "top"
      ? marginY
      : vertical === "bottom"
        ? height - marginY - blockHeight
        : (height - blockHeight) / 2;
  const x =
    horizontal === "left"
      ? marginX
      : horizontal === "right"
        ? width - marginX
        : width / 2;
  const anchor =
    horizontal === "left" ? "start" : horizontal === "right" ? "end" : "middle";
  const boxWidth = longest * fontSize * 0.65;
  const left = anchor === "start" ? x : anchor === "end" ? x - boxWidth : x - boxWidth / 2;
  return { width, height, lines, fontSize, lineHeight, anchor, x, y, bounds: { x: left, y, width: boxWidth, height: blockHeight } };
}

export function textSvg(clip: TextClip, format: Format, transform: LayerTransform = identityTransform) {
  const { width, height, lines, fontSize, lineHeight, anchor, x, y, bounds } = textLayout(clip, format);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const matrix = `translate(${cx + transform.x * width} ${cy + transform.y * height}) rotate(${transform.rotation}) scale(${transform.scale}) translate(${-cx} ${-cy})`;
  const fill = /^#[\da-f]{6}$/i.test(clip.color) ? clip.color : "#ffffff";
  const rows = lines.map(
    (line, index) =>
      `<text x="${x}" y="${y + fontSize + index * lineHeight}">${escapeXml(line)}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="${matrix}" xml:space="preserve" font-family="Consolas, monospace" font-weight="bold" font-size="${fontSize}" text-anchor="${anchor}" fill="${fill}">${rows.join("")}</g></svg>`;
}
