import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { run, encoding } from "../server/media.ts";
await mkdir("assets", { recursive: true });
if (!existsSync("assets/demo.mp4"))
  await run([
    "-f",
    "lavfi",
    "-i",
    "gradients=size=960x540:rate=30:c0=0x102b46:c1=0x32d6cf:c2=0x9275df:c3=0x171923:nb_colors=4:speed=0.08",
    "-t",
    "6",
    ...encoding,
    "assets/demo.mp4",
  ]);
await writeFile(
  "assets/LICENSE.txt",
  "Demo video: an original procedural color animation generated for AI Video Studio using FFmpeg gradients. Dedicated to the public domain under CC0-1.0. No third-party footage, images, or audio. You may copy, modify, and redistribute the demo video. FFmpeg itself is separately licensed; see node_modules/ffmpeg-static/LICENSE and its bundled binary license.\n",
);
console.log("Offline demo clip ready.");
