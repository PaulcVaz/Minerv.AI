import { test } from "node:test";
import assert from "node:assert/strict";
import { useStudio } from "../src/store.ts";
import { createProject, reconcile } from "../server/domain.ts";
import { editorStructure } from "../shared/types.ts";

test("editor history records successful structure changes only and preserves redo identities", async () => {
  const originalFetch = globalThis.fetch;
  let server = createProject("Client history"),
    fail = false;
  globalThis.fetch = async (_url, options) => {
    if (fail)
      return new Response(JSON.stringify({ error: "Disk unavailable" }), {
        status: 400,
      });
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (String(_url).endsWith("/structure")) {
      assert.deepEqual(editorStructure(server), body.expected);
      server.keyframes = body.target.keyframes;
      server.staticImageClips = body.target.staticImageClips;
      reconcile(server);
    } else if (options?.method === "POST") {
      server.keyframes.push({ id: "new-key", name: "Key", timeMs: 0 });
      reconcile(server);
    } else if (options?.method === "PATCH") server.selectedId = "new-key";
    return new Response(JSON.stringify(server), { status: 200 });
  };
  try {
    useStudio.setState({
      project: structuredClone(server),
      past: [],
      future: [],
      saving: 0,
      failed: false,
      failedRequest: null,
    });
    await useStudio
      .getState()
      .mutate("/projects/" + server.id + "/keyframes", "POST", { timeMs: 0 });
    assert.equal(useStudio.getState().past.length, 1);
    await useStudio
      .getState()
      .mutate("/projects/" + server.id, "PATCH", { selectedId: "new-key" });
    assert.equal(useStudio.getState().past.length, 1);
    useStudio.getState().copy();
    assert.equal(useStudio.getState().clipboard?.kind, "keyframe");
    await useStudio.getState().undo();
    assert.equal(useStudio.getState().project?.keyframes.length, 0);
    await useStudio.getState().undo(true);
    assert.equal(useStudio.getState().project?.keyframes[0].id, "new-key");
    fail = true;
    await assert.rejects(
      useStudio
        .getState()
        .mutate("/projects/" + server.id + "/keyframes", "POST", { timeMs: 4 }),
    );
    assert.equal(useStudio.getState().past.length, 1);
    assert.equal(useStudio.getState().failed, true);
    useStudio.getState().resetEditing();
    assert.equal(useStudio.getState().clipboard, null);
    assert.equal(useStudio.getState().past.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
