export class InterchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterchangeError";
  }
}

export class FactConflictError extends InterchangeError {
  readonly conflicts: Record<string, [unknown, unknown]>;

  constructor(conflicts: Record<string, [unknown, unknown]>) {
    const detail = Object.entries(conflicts)
      .map(([k, [a, b]]) => `${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
      .join(", ");
    super(`Fact conflicts detected: ${detail}`);
    this.name = "FactConflictError";
    this.conflicts = conflicts;
  }
}

export class CyclicDependencyError extends InterchangeError {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" → ")}`);
    this.name = "CyclicDependencyError";
    this.cycle = cycle;
  }
}

export class RoutingError extends InterchangeError {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

export class TranslationError extends InterchangeError {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export class TaskNotFoundError extends InterchangeError {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class BatonValidationError extends InterchangeError {
  constructor(message: string) {
    super(message);
    this.name = "BatonValidationError";
  }
}
