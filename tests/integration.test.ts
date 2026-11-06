import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { DemoProvider, run } from "../server/media.ts";
import { Store } from "../server/store.ts";
import { Jobs } from "../server/jobs.ts";
import { createProject, id, reconcile } from "../server/domain.ts";
import { timeline, active, signature, type Project } from "../shared/types.ts";
test(
  "full local workflow, real encoding, version isolation, preview, export and API failures",
  { timeout: 180000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "studio-api-"));
    const { app, store, jobs } = createApp(root);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    async function request(route: string, method = "GET", body?: unknown) {
      const r = await fetch(base + "/api" + route, {
        method,
        headers:
          body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    }
    async function idle() {
      const end = Date.now() + 120000;
      while (jobs.running) {
        if (Date.now() > end) throw new Error("Jobs timed out");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      let p = (await request("/projects", "POST", { name: "Acceptance" }))
        .body as Project;
      const route = "/projects/" + p.id;
      await request(route, "PATCH", {
        format: { ratio: "16:9", resolution: 720, fps: 24 },
      });
      const form = new FormData();
      for (let i = 0; i < 4; i++) {
        const buffer = await sharp({
          create: {
            width: 320,
            height: 180,
            channels: 3,
            background: ["#174854", "#775291", "#9d6448", "#254c83"][i],
          },
        })
          .png()
          .toBuffer();
        form.append(
          "images",
          new Blob([new Uint8Array(buffer)], { type: "image/png" }),
          `frame-${i}.png`,
        );
      }
      p = (await request(route + "/images", "POST", form)).body;
      assert.equal(p.media.length, 4);
      assert.equal(p.keyframes.length, 0);
      for (const [index, asset] of p.media.entries())
        p = (
          await request(route + "/media/" + asset.id + "/keyframes", "POST", {
            timeMs: index * 1000,
          })
        ).body;
      assert.equal(p.keyframes.length, 4);
      const segments = timeline(p);
      for (const [i, s] of segments.entries())
        assert.equal(
          (
            await request(route + "/segments/" + s.id, "PATCH", {
              model: "Demo",
              continuity: i === 1 ? "Cut" : "Continuous",
              prompt: `Scene ${i}`,
            })
          ).status,
          200,
        );
      for (const s of segments)
        assert.equal(
          (await request(route + "/segments/" + s.id + "/generate", "POST"))
            .status,
          202,
        );
      await idle();
      p = store.get(p.id);
      assert.ok(timeline(p).every((s) => active(s)?.file));
      const ids = timeline(p).map((s) => s.activeId);
      assert.equal(p.jobs.filter((j) => j.kind === "preview").length, 0);
      assert.equal((await request(route + "/preview", "POST")).status, 202);
      await request(
        route + "/segments/" + segments[1].id + "/generate",
        "POST",
      );
      await idle();
      p = store.get(p.id);
      assert.equal(timeline(p)[0].activeId, ids[0]);
      assert.notEqual(timeline(p)[1].activeId, ids[1]);
      assert.equal(timeline(p)[2].activeId, ids[2]);
      await request(route + "/segments/" + segments[1].id + "/active", "PUT", {
        generationId: ids[1],
      });
      await idle();
      assert.equal(timeline(store.get(p.id))[1].activeId, ids[1]);
      const beforeMove = store.get(p.id).keyframes.map((k) => k.timeMs);
      assert.equal(
        (
          await request(
            route + "/segments/" + segments[1].id + "/move",
            "PATCH",
            { deltaMs: 1000 },
          )
        ).status,
        200,
      );
      p = store.get(p.id);
      assert.deepEqual(
        p.keyframes.map((k) => k.timeMs),
        beforeMove.map((timeMs) => timeMs + 1000),
      );
      assert.deepEqual(
        timeline(p).map((s) => s.activeId),
        ids,
      );
      await request(route, "PATCH", { selectedId: segments[1].id });
      assert.equal((await request(route)).body.selectedId, segments[1].id);
      await request(route + "/export", "POST");
      await request(route, "PATCH", {
        format: { ratio: "1:1", resolution: 720, fps: 30 },
      });
      await idle();
      p = store.get(p.id);
      const exp = p.jobs.find((j) => j.kind === "export")!;
      assert.equal(exp.status, "Completed");
      assert.equal(exp.format.ratio, "16:9");
      assert.deepEqual(exp.generationIds, ids);
      assert.ok(existsSync(path.join(root, exp.file!)));
      await run(["-i", path.join(root, exp.file!), "-f", "null", "-"]);
      const bytes = readFileSync(path.join(root, exp.file!));
      assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
      const download = await fetch(
        base + "/api" + route + "/exports/" + exp.id + "/download",
      );
      assert.equal(download.status, 200);
      assert.match(download.headers.get("content-disposition")!, /attachment/);
      const range = await fetch(base + "/media/" + exp.file, {
        headers: { Range: "bytes=0-99" },
      });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 100);
      assert.equal((await fetch(base + "/media/studio.sqlite")).status, 404);
      const invalid = new FormData();
      invalid.append(
        "images",
        new Blob(["bad"], { type: "image/png" }),
        "bad.png",
      );
      assert.equal(
        (await request(route + "/images", "POST", invalid)).status,
        400,
      );
      assert.equal(store.get(p.id).keyframes.length, 4);
      assert.equal(
        (
          await request(
            route + "/media/" + p.media[0].id + "/static-clips",
            "POST",
            { startTimeMs: 0, durationMs: 0 },
          )
        ).status,
        400,
      );
      p = (
        await request(
          route + "/media/" + p.media[0].id + "/static-clips",
          "POST",
          { startTimeMs: 1500, durationMs: 1000 },
        )
      ).body;
      assert.equal(p.staticImageClips.length, 1);
      assert.equal((await request(route + "/export", "POST")).status, 409);
      p = (
        await request(
          route + "/static-clips/" + p.staticImageClips[0].id,
          "PATCH",
          { startTimeMs: 4000, durationMs: 1000 },
        )
      ).body;
      assert.equal(p.staticImageClips[0].startTimeMs, 4000);
      assert.equal((await request(route + "/export", "POST")).status, 202);
      await idle();
      assert.equal(
        store
          .get(p.id)
          .jobs.filter((j) => j.kind === "export")
          .at(-1)?.status,
        "Completed",
      );
      const originalSave = store.save.bind(store);
      store.save = () => {
        throw new Error("Simulated disk failure");
      };
      assert.equal(
        (await request(route, "PATCH", { name: "lost" })).status,
        400,
      );
      store.save = originalSave;
      assert.equal(store.get(p.id).name, "Acceptance");
    } finally {
      await idle();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("timeline move endpoints validate keyframes and generated chains atomically", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-moves-"));
  const { app, store } = createApp(root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;
  const request = async (route: string, body: unknown) => {
    const response = await fetch(base + route, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const project = createProject("moves");
    project.keyframes = [0, 4000, 8000, 12000].map((timeMs, index) => ({
      id: `keyframe-${index}`,
      name: `Frame ${index}`,
      image: `frame-${index}.webp`,
      timeMs,
    }));
    reconcile(project);
    const segments = timeline(project);
    for (const segment of [segments[0], segments[2]]) {
      segment.generations.push({
        id: `generation-${segment.id}`,
        status: "Completed",
        settings: { ...segment.settings },
        durationMs: 4000,
        format: { ...project.format },
        createdAt: "now",
        file: `${segment.id}.mp4`,
      });
      segment.activeId = `generation-${segment.id}`;
    }
    store.save(project);
    const route = `/projects/${project.id}`;

    let result = await request(
      `${route}/keyframes/${project.keyframes[2].id}`,
      { timeMs: 9000 },
    );
    assert.equal(result.status, 200);
    assert.equal(store.get(project.id).keyframes[2].timeMs, 9000);
    result = await request(`${route}/keyframes/${project.keyframes[2].id}`, {
      timeMs: 12000,
    });
    assert.equal(result.status, 400);
    assert.equal(store.get(project.id).keyframes[2].timeMs, 9000);

    const before = store
      .get(project.id)
      .keyframes.map((keyframe) => keyframe.timeMs);
    result = await request(`${route}/segments/${segments[0].id}/move`, {
      deltaMs: 7000,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(
      store.get(project.id).keyframes.map((keyframe) => keyframe.timeMs),
      before,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("generated segment split creates physical active versions without losing history", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-split-"));
  const { app, store, jobs } = createApp(root);
  const project = createProject("split api");
  project.keyframes = [
    { id: "start", name: "start", image: "start.webp", timeMs: 0 },
    { id: "end", name: "end", image: "end.webp", timeMs: 8000 },
  ];
  reconcile(project);
  const original = timeline(project)[0];
  const sourceRelative = `${project.id}/source.mp4`;
  mkdirSync(path.join(root, project.id), { recursive: true });
  await run([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-t",
    "8",
    "-pix_fmt",
    "yuv420p",
    path.join(root, sourceRelative),
  ]);
  original.generations.push({
    id: "source-generation",
    status: "Completed",
    settings: { ...original.settings },
    durationMs: 8000,
    format: { ...project.format },
    createdAt: "now",
    file: sourceRelative,
  });
  original.activeId = "source-generation";
  store.save(project);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/projects/${project.id}`;
  try {
    const response = await fetch(`${base}/segments/${original.id}/keyframes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeMs: 3000 }),
    });
    assert.equal(response.status, 200);
    const split = (await response.json()) as Project;
    assert.equal(
      split.keyframes.find((item) => item.timeMs === 3000)?.image,
      split.media.at(-1)?.image,
    );
    assert.ok(split.segments.some((segment) => segment.id === original.id));
    const current = timeline(split);
    assert.deepEqual(
      current.map((segment) => active(segment)?.durationMs),
      [3000, 5000],
    );
    for (const segment of current) {
      const generation = active(segment)!;
      assert.equal(generation.derivedFromGenerationId, "source-generation");
      assert.ok(existsSync(path.join(root, generation.file!)));
      assert.equal(
        (await fetch(new URL("/media/" + generation.file, base))).status,
        200,
      );
      await run(["-i", path.join(root, generation.file!), "-f", "null", "-"]);
    }
    assert.ok(existsSync(path.join(root, split.media.at(-1)!.image)));
    assert.equal(
      (
        await sharp(
          readFileSync(path.join(root, split.media.at(-1)!.image)),
        ).metadata()
      ).format,
      "webp",
    );
    const clear = await fetch(`${base}/segments/${current[0].id}/active`, {
      method: "DELETE",
    });
    assert.equal(clear.status, 200);
    const cleared = (await clear.json()) as Project;
    const clearedSegment = cleared.segments.find(
      (segment) => segment.id === current[0].id,
    )!;
    assert.equal(clearedSegment.activeId, undefined);
    assert.equal(clearedSegment.generations.length, 1);
  } finally {
    while (jobs.running)
      await new Promise((resolve) => setTimeout(resolve, 50));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("missing FFmpeg and missing demo produce useful failures", async () => {
  await assert.rejects(
    run(["-version"], "Z:/missing-studio-ffmpeg.exe"),
    /FFmpeg unavailable/,
  );
  const demo = new DemoProvider("Z:/missing-demo.mp4");
  await assert.rejects(
    demo.generate({
      startImage: "a",
      endImage: "b",
      settings: {
        prompt: "",
        continuity: "Neutral",
        model: "Demo",
        seed: "",
      },
      durationMs: 1000,
      format: { ratio: "16:9", resolution: 720, fps: 24 },
      output: "unused",
    }),
    /Demo clip missing/,
  );
});

test("failed regeneration preserves the approved version and can be retried", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-failure-"));
  const store = new Store(root);
  try {
    const p = createProject("failure");
    p.keyframes = [
      { id: id(), name: "a", image: "a.webp", timeMs: 0 },
      { id: id(), name: "b", image: "b.webp", timeMs: 1000 },
    ];
    reconcile(p);
    const s = timeline(p)[0];
    s.settings.model = "Demo";
    s.generations.push({
      id: "approved",
      status: "Completed",
      settings: { ...s.settings },
      durationMs: 1000,
      format: { ...p.format },
      createdAt: "now",
      file: "approved.mp4",
    });
    s.activeId = "approved";
    store.save(p);
    const jobs = new Jobs(store, {
      generate: async () => {
        throw new Error("Simulated provider failure");
      },
    });
    jobs.generate(p.id, s.id);
    while (jobs.running) await new Promise((r) => setTimeout(r, 10));
    let current = store.get(p.id);
    assert.equal(timeline(current)[0].activeId, "approved");
    assert.equal(timeline(current)[0].generations.at(-1)?.status, "Failed");
    jobs.generate(p.id, s.id);
    while (jobs.running) await new Promise((r) => setTimeout(r, 10));
    current = store.get(p.id);
    assert.equal(timeline(current)[0].generations.length, 3);
    assert.equal(timeline(current)[0].activeId, "approved");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
