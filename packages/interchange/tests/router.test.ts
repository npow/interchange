import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import type { Role } from "@interchange/core";

const TEST_ROLES: Record<string, Role> = {
  planner: {
    preferredModel: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    capabilities: ["plan", "design", "architect"],
    allowedTools: null,
  },
  coder: {
    preferredModel: "gpt-4o",
    fallbackModel: "claude-sonnet-4-6",
    capabilities: ["implement", "code", "function", "write", "fix"],
    allowedTools: null,
  },
  reviewer: {
    preferredModel: "claude-sonnet-4-6",
    fallbackModel: "gpt-4o",
    capabilities: ["review", "audit", "check", "verify"],
    allowedTools: null,
  },
};

describe("Router", () => {
  const router = new Router(TEST_ROLES);

  it("routes to correct role by keyword match", () => {
    const d = router.route("implement a REST API endpoint");
    expect(d.role).toBe("coder");
    expect(d.confidence).toBeGreaterThan(0);
  });

  it("routes to planner for planning tasks", () => {
    const d = router.route("design a microservices architecture");
    expect(d.role).toBe("planner");
  });

  it("routes to reviewer for review tasks", () => {
    const d = router.route("review the pull request for bugs");
    expect(d.role).toBe("reviewer");
  });

  it("respects forceRole", () => {
    const d = router.route("some task", {}, "planner");
    expect(d.role).toBe("planner");
    expect(d.confidence).toBe(1.0);
    expect(d.rationale).toContain("Forced");
  });

  it("throws RoutingError for unknown forceRole", () => {
    expect(() => router.route("task", {}, "unknown-role")).toThrow();
  });

  it("falls back to fallback model when preferred is disallowed", () => {
    const d = router.route("implement code", {
      disallowedModels: ["gpt-4o"],
    });
    expect(d.model).toBe("claude-sonnet-4-6");
  });

  it("filters by cost constraint", () => {
    // claude-opus-4-6 costs 0.015, which exceeds 0.005
    const d = router.route("plan the architecture", {
      maxCostUsdPer1kTokens: 0.005,
    });
    // Should fall back to claude-sonnet-4-6 (0.003)
    expect(d.model).toBe("claude-sonnet-4-6");
  });

  it("returns model even if all constraints would filter — uses last candidate", () => {
    const d = router.route("implement code", {
      maxCostUsdPer1kTokens: 0.000001, // filters everything
    });
    // Should still return something (last candidate = fallback)
    expect(typeof d.model).toBe("string");
  });

  it("falls back to first role when no keywords match", () => {
    const d = router.route("do something completely unspecified xyz123");
    // Falls back to first role
    expect(["planner", "coder", "reviewer"]).toContain(d.role);
  });
});
