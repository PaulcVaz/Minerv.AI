import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PendingDeletion, Project } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { createProject } from "../server/domain.ts";

test("project deletion is pending, durable, reversible and finalizable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-deletion-"));
  let instance = createApp(root);
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let port = (server.address() as { port: number }).port;

  async function request(route: string, method = "GET", body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function restart() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    instance.store.close();
    instance = createApp(root);
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as { port: number }).port;
  }

  try {
    const original = (
      await request("/projects", "POST", { name: "Keep every field" })
    ).body as Project;
    original.selectedId = "selected-keyframe";
    original.keyframes.push({
      id: "selected-keyframe",
      name: "frame.png",
      image: `${original.id}/media.webp`,
      timeMs: 0,
    });
    instance.store.save(original);
    const completeDocument = instance.store.get(original.id);
    const mediaDir = path.join(root, original.id);
    const mediaFile = path.join(mediaDir, "media.webp");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(mediaFile, "retained media", { flag: "w" });

    const begun = await request(`/projects/${original.id}`, "DELETE");
    assert.equal(begun.status, 202);
    const pending = begun.body as PendingDeletion;
    assert.equal(pending.projectId, original.id);
    assert.equal((await request("/projects")).body.length, 0);
    assert.equal((await request(`/projects/${original.id}`)).status, 404);
    assert.equal((await request("/deletions")).body.length, 1);

    const repeated = await request(`/projects/${original.id}`, "DELETE");
    assert.equal(repeated.status, 202);
    assert.equal(repeated.body.id, pending.id);

    await restart();
    assert.equal((await request("/deletions")).body[0].id, pending.id);
    const undoDeletion = instance.store.undoDeletion.bind(instance.store);
    instance.store.undoDeletion = () => {
      throw new Error("Simulated undo failure");
    };
    assert.equal(
      (await request(`/deletions/${pending.id}/undo`, "POST")).status,
      400,
    );
    assert.equal(instance.store.pending()[0].id, pending.id);
    instance.store.undoDeletion = undoDeletion;
    assert.equal(
      (await request(`/deletions/${pending.id}/undo`, "POST")).body.status,
      "restored",
    );
    assert.deepEqual(
      await request(`/projects/${original.id}`).then((r) => r.body),
      completeDocument,
    );

    const pendingAgain = (await request(`/projects/${original.id}`, "DELETE"))
      .body as PendingDeletion;
    const finalizeDeletion = instance.store.finalizeDeletion.bind(
      instance.store,
    );
    instance.store.finalizeDeletion = () => {
      throw new Error("Simulated finalize failure");
    };
    assert.equal(
      (await request(`/deletions/${pendingAgain.id}`, "DELETE")).status,
      400,
    );
    assert.equal(instance.store.pending()[0].id, pendingAgain.id);
    instance.store.finalizeDeletion = finalizeDeletion;
    assert.equal(
      (await request(`/deletions/${pendingAgain.id}`, "DELETE")).body.status,
      "finalized",
    );
    assert.equal((await request("/deletions")).body.length, 0);
    assert.equal((await request(`/projects/${original.id}`)).status, 404);
    assert.equal(existsSync(mediaFile), true);
    assert.equal(
      (await request(`/deletions/${pendingAgain.id}`, "DELETE")).body.status,
      "missing",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects with active work cannot enter pending deletion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-deletion-active-"));
  const { app, store } = createApp(root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const createdResponse = await fetch(
      `http://127.0.0.1:${port}/api/projects`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Busy" }),
      },
    );
    const project = (await createdResponse.json()) as Project;
    project.jobs.push({
      id: "active-export",
      kind: "export",
      signature: "snapshot",
      generationIds: [],
      format: project.format,
      status: "Generating",
      createdAt: new Date().toISOString(),
    });
    store.save(project);
    const safe = createProject("Safe batch member");
    store.save(safe);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/projects/${project.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /running jobs/);
    assert.equal(store.pending().length, 0);
    assert.equal(store.get(project.id).id, project.id);

    const blockedBatch = await fetch(`http://127.0.0.1:${port}/api/deletions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: [safe.id, project.id] }),
    });
    assert.equal(blockedBatch.status, 400);
    assert.equal(store.pending().length, 0);
    assert.equal(store.get(safe.id).id, safe.id);

    project.jobs[0].status = "Failed";
    store.save(project);
    const acceptedBatch = await fetch(
      `http://127.0.0.1:${port}/api/deletions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: [safe.id, project.id] }),
      },
    );
    assert.equal(acceptedBatch.status, 202);
    const pendingBatch = (await acceptedBatch.json()) as PendingDeletion[];
    assert.equal(pendingBatch.length, 2);
    assert.equal(store.list().length, 0);
    for (const pending of pendingBatch)
      assert.equal(store.undoDeletion(pending.id), "restored");
    assert.equal(store.list().length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
