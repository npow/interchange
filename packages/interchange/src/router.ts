/**
 * Router: classifies tasks to roles and selects models.
 *
 * Classification is keyword/capability based. Each Role has a preferred
 * model and a fallback. RouteConstraints can filter by cost or latency.
 */
import { RoutingError } from "@interchange/core";
import type { Role, RouteConstraints, RouteDecision } from "@interchange/core";

// Cost in USD per 1k tokens (input + output blended estimate)
const MODEL_COSTS: Record<string, number> = {
  "claude-opus-4-6": 0.015,
  "claude-sonnet-4-6": 0.003,
  "claude-haiku-4-5-20251001": 0.00025,
  "gpt-4o": 0.005,
  "gpt-4o-mini": 0.00015,
  "gemini-2.0-flash": 0.000075,
  "gemini-1.5-pro": 0.00125,
};

export class Router {
  constructor(private roles: Record<string, Role>) {}

  route(
    task: string,
    constraints: RouteConstraints = {},
    forceRole?: string
  ): RouteDecision {
    const roleName = forceRole ?? this._classify(task);
    const role = this.roles[roleName];
    if (!role) {
      throw new RoutingError(
        `Unknown role: ${roleName}. Available: ${Object.keys(this.roles).join(", ")}`
      );
    }

    const model = this._selectModel(role, constraints);
    const confidence = forceRole ? 1.0 : this._confidence(task, roleName, role);

    return {
      role: roleName,
      model,
      confidence,
      rationale: forceRole
        ? `Forced to role: ${roleName}`
        : `Classified as ${roleName} (confidence=${confidence.toFixed(2)})`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _classify(task: string): string {
    const lower = task.toLowerCase();
    const scores: Record<string, number> = {};

    for (const [roleName, role] of Object.entries(this.roles)) {
      let score = 0;
      for (const cap of role.capabilities) {
        if (lower.includes(cap.toLowerCase())) score += 1;
      }
      scores[roleName] = score;
    }

    // Return highest-scoring role; fall back to first role
    const best = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
    return best && best[1] > 0 ? best[0] : Object.keys(this.roles)[0] ?? "planner";
  }

  private _selectModel(role: Role, constraints: RouteConstraints): string {
    const candidates = [role.preferredModel, role.fallbackModel];
    const disallowed = new Set(constraints.disallowedModels ?? []);

    for (const model of candidates) {
      if (disallowed.has(model)) continue;

      if (constraints.maxCostUsdPer1kTokens !== undefined) {
        const cost = MODEL_COSTS[model] ?? 999;
        if (cost > constraints.maxCostUsdPer1kTokens) continue;
      }

      return model;
    }

    // If all candidates filtered, fall back to the last one anyway
    return role.fallbackModel;
  }

  private _confidence(task: string, roleName: string, role: Role): number {
    const lower = task.toLowerCase();
    const matches = role.capabilities.filter((cap) =>
      lower.includes(cap.toLowerCase())
    ).length;
    const total = role.capabilities.length || 1;
    return Math.min(1.0, matches / total + 0.3);
  }
}
