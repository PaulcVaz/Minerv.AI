import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  segmentImages,
  type PendingDeletion,
  type Project,
} from "../shared/types.ts";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, "studio.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);",
    );
    const version = this.db
      .prepare("SELECT MAX(version) AS version FROM migrations")
      .get() as { version: number | null };
    if (!version.version)
      this.db.exec(
        "BEGIN; CREATE TABLE projects(id TEXT PRIMARY KEY, document TEXT NOT NULL); INSERT INTO migrations VALUES(1); COMMIT;",
      );
    const current = this.db
      .prepare("SELECT MAX(version) AS version FROM migrations")
      .get() as { version: number | null };
    if ((current.version || 0) < 2)
      this.db.exec(`
        BEGIN;
        CREATE TABLE pending_deletions(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
          project_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO migrations VALUES(2);
        COMMIT;
      `);
  }
  list(): Project[] {
    return (
      this.db
        .prepare(
          "SELECT document FROM projects WHERE id NOT IN (SELECT project_id FROM pending_deletions)",
        )
        .all() as {
        document: string;
      }[]
    )
      .map((r) => JSON.parse(r.document) as Project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): Project {
    const row = this.db
      .prepare(
        "SELECT document FROM projects WHERE id=? AND id NOT IN (SELECT project_id FROM pending_deletions)",
      )
      .get(id) as { document: string } | undefined;
    if (!row)
      throw Object.assign(new Error("Project not found"), { status: 404 });
    const project = JSON.parse(row.document) as Project;
    let migrated = false;
    for (const segment of project.segments)
      for (const generation of segment.generations)
        if (!generation.inputImages) {
          generation.inputImages = segmentImages(project, segment);
          migrated = true;
        }
    if (migrated) this.save(project);
    return project;
  }
  save(p: Project) {
    p.updatedAt = new Date().toISOString();
    p.revision++;
    this.db
      .prepare(
        "INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      )
      .run(p.id, JSON.stringify(p));
    return p;
  }
  pending(): PendingDeletion[] {
    return this.db
      .prepare(
        "SELECT id, project_id AS projectId, project_name AS projectName, created_at AS createdAt FROM pending_deletions ORDER BY created_at, id",
      )
      .all() as unknown as PendingDeletion[];
  }
  pendingForProject(projectId: string): PendingDeletion | undefined {
    return this.db
      .prepare(
        "SELECT id, project_id AS projectId, project_name AS projectName, created_at AS createdAt FROM pending_deletions WHERE project_id=?",
      )
      .get(projectId) as unknown as PendingDeletion | undefined;
  }
  beginDeletion(p: Project, deletionId: string): PendingDeletion {
    return this.beginDeletions([{ project: p, deletionId }])[0];
  }
  beginDeletions(
    entries: { project: Project; deletionId: string }[],
  ): PendingDeletion[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = entries.map(({ project, deletionId }) => {
        const existing = this.pendingForProject(project.id);
        if (existing) return existing;
        const pending: PendingDeletion = {
          id: deletionId,
          projectId: project.id,
          projectName: project.name,
          createdAt: new Date().toISOString(),
        };
        this.db
          .prepare(
            "INSERT INTO pending_deletions(id, project_id, project_name, created_at) VALUES(?,?,?,?)",
          )
          .run(
            pending.id,
            pending.projectId,
            pending.projectName,
            pending.createdAt,
          );
        return pending;
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  undoDeletion(id: string): "restored" | "missing" | "finalized" {
    const row = this.db
      .prepare(
        "SELECT project_id AS projectId FROM pending_deletions WHERE id=?",
      )
      .get(id) as { projectId: string } | undefined;
    if (!row) return "missing";
    const exists = this.db
      .prepare("SELECT 1 AS found FROM projects WHERE id=?")
      .get(row.projectId);
    if (!exists) return "finalized";
    this.db.prepare("DELETE FROM pending_deletions WHERE id=?").run(id);
    return "restored";
  }
  finalizeDeletion(id: string): "finalized" | "missing" {
    const transaction = this.db.prepare(
      "SELECT project_id AS projectId FROM pending_deletions WHERE id=?",
    );
    const row = transaction.get(id) as { projectId: string } | undefined;
    if (!row) return "missing";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM pending_deletions WHERE id=?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(row.projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return "finalized";
  }
  close() {
    this.db.close();
  }
}
