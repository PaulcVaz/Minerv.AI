import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
const { app } = createApp();
if (existsSync("dist/index.html") && process.env.STUDIO_DEV !== "1") {
  app.use(express.static("dist"));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 4310);
app.listen(port, "127.0.0.1", () =>
  console.log(`AI Video Studio: http://127.0.0.1:${port}`),
);
