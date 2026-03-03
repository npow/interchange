import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { WorldState } from "../types.js";
import { serializeState, deserializeState } from "./serialization.js";

// ---------------------------------------------------------------------------
// StateBackend interface
// ---------------------------------------------------------------------------

export interface StateBackend {
  save(state: WorldState): void;
  load(taskId: string): WorldState | null;
  listTasks(): string[];
}

// ---------------------------------------------------------------------------
// MemoryBackend
// ---------------------------------------------------------------------------

/**
 * In-process memory backend. Not persistent.
 *
 * Serialises through JSON on every save/load to guarantee no shared
 * references between the stored snapshot and the live WorldState object.
 */
export class MemoryBackend implements StateBackend {
  private store: Map<string, string> = new Map();

  save(state: WorldState): void {
    this.store.set(state.taskId, JSON.stringify(serializeState(state)));
  }

  load(taskId: string): WorldState | null {
    const raw = this.store.get(taskId);
    if (!raw) return null;
    return deserializeState(JSON.parse(raw) as Record<string, unknown>);
  }

  listTasks(): string[] {
    return [...this.store.keys()];
  }
}

// ---------------------------------------------------------------------------
// JSONFileBackend
// ---------------------------------------------------------------------------

/**
 * File-based persistent state. Stores all tasks in a single JSON file.
 * Thread-safety: last-write-wins (single process assumed).
 */
export class JSONFileBackend implements StateBackend {
  private path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private loadAll(): Record<string, Record<string, unknown>> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
    } catch {
      return {};
    }
  }

  private saveAll(data: Record<string, Record<string, unknown>>): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
  }

  save(state: WorldState): void {
    const data = this.loadAll();
    data[state.taskId] = serializeState(state) as Record<string, unknown>;
    this.saveAll(data);
  }

  load(taskId: string): WorldState | null {
    const data = this.loadAll();
    const raw = data[taskId];
    return raw ? deserializeState(raw) : null;
  }

  listTasks(): string[] {
    return Object.keys(this.loadAll());
  }
}
