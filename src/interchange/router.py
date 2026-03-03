"""Role-aware router: maps a task description to a role and model."""
from __future__ import annotations

from .exceptions import RoutingError
from .models import Role, RouteConstraints, RouteDecision

# ---------------------------------------------------------------------------
# Model cost table (USD per 1k tokens, approximate input price)
# Used when RouteConstraints.max_cost_usd_per_1k_tokens is set.
# ---------------------------------------------------------------------------
_MODEL_COSTS: dict[str, float] = {
    "claude-opus-4-6": 0.015,
    "claude-sonnet-4-6": 0.003,
    "claude-haiku-4-5-20251001": 0.00025,
    "gpt-4o": 0.005,
    "gpt-4o-mini": 0.00015,
    "o1": 0.015,
    "o3-mini": 0.0011,
    "gemini-2.0-pro": 0.007,
    "gemini-2.0-flash": 0.00035,
}

# Default capabilities keywords per role (used when no capabilities defined on Role).
_DEFAULT_CAPABILITIES: dict[str, list[str]] = {
    "planner": [
        "plan", "design", "architect", "strategy", "decompose", "organise",
        "organize", "structure", "decide", "coordinate", "roadmap",
    ],
    "coder": [
        "implement", "write", "code", "function", "class", "bug", "fix",
        "develop", "build", "test", "refactor", "debug", "program",
    ],
    "reviewer": [
        "review", "check", "audit", "verify", "validate", "assess",
        "evaluate", "inspect", "critique", "approve", "feedback",
    ],
    "researcher": [
        "research", "find", "search", "investigate", "analyse", "analyze",
        "explore", "summarise", "summarize", "understand", "learn", "discover",
    ],
}

_LOW_CONFIDENCE_THRESHOLD = 0.4


class Router:
    """Keyword-based role classifier with constraint-aware model selection.

    Scoring algorithm:
      1. Normalise task description to lowercase tokens.
      2. For each role, count how many of its capability keywords appear.
      3. confidence = matched / total_keywords_for_role (capped at 1.0).
      4. Pick the role with the highest score; tie-break to the first defined role.
      5. Apply RouteConstraints to choose preferred vs fallback model.
    """

    def __init__(self, roles: dict[str, Role]) -> None:
        if not roles:
            raise ValueError("At least one role must be defined")
        self._roles = roles

    @property
    def roles(self) -> dict[str, Role]:
        return dict(self._roles)

    def route(
        self,
        task: str,
        constraints: RouteConstraints | None = None,
        force_role: str | None = None,
    ) -> RouteDecision:
        """Return a RouteDecision for the given task description.

        Args:
            task: Natural-language description of the work to be done.
            constraints: Optional hard limits on cost, latency, or disallowed models.
            force_role: If given, skip classification and use this role directly.

        Raises:
            RoutingError: If force_role is provided but not registered, or if no
                          model survives constraint filtering.
        """
        constraints = constraints or RouteConstraints()

        if force_role is not None:
            if force_role not in self._roles:
                raise RoutingError(
                    f"Role {force_role!r} not in registry. "
                    f"Available: {list(self._roles)}"
                )
            role_name = force_role
            confidence = 1.0
            rationale = f"Role forced to {force_role!r}"
        else:
            role_name, confidence = self._classify(task)
            rationale = self._build_rationale(task, role_name, confidence)

        model = self._select_model(role_name, constraints)
        return RouteDecision(
            role=role_name,
            model=model,
            confidence=confidence,
            rationale=rationale,
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _classify(self, task: str) -> tuple[str, float]:
        """Return (best_role, confidence) based on keyword overlap."""
        tokens = set(task.lower().split())
        best_role = list(self._roles.keys())[0]
        best_score = -1.0

        for role_name, role in self._roles.items():
            keywords = role.capabilities or _DEFAULT_CAPABILITIES.get(role_name, [])
            if not keywords:
                continue
            matches = sum(1 for kw in keywords if kw in tokens)
            score = matches / len(keywords)
            if score > best_score:
                best_score = score
                best_role = role_name

        # If nothing matched at all, fall back to first role with confidence 0
        confidence = max(0.0, min(1.0, best_score))
        return best_role, confidence

    def _select_model(self, role_name: str, constraints: RouteConstraints) -> str:
        """Pick preferred or fallback model, respecting constraints."""
        role = self._roles[role_name]
        candidates = [role.preferred_model, role.fallback_model]

        # Filter disallowed
        candidates = [m for m in candidates if m not in constraints.disallowed_models]

        # Filter by cost
        if constraints.max_cost_usd_per_1k_tokens is not None:
            candidates = [
                m for m in candidates
                if _MODEL_COSTS.get(m, 0.0) <= constraints.max_cost_usd_per_1k_tokens
            ]

        if not candidates:
            raise RoutingError(
                f"No model available for role {role_name!r} after applying constraints. "
                f"Preferred={role.preferred_model!r}, Fallback={role.fallback_model!r}, "
                f"Constraints={constraints}"
            )

        return candidates[0]

    @staticmethod
    def _build_rationale(task: str, role: str, confidence: float) -> str:
        quality = "high" if confidence >= 0.6 else "medium" if confidence >= 0.4 else "low"
        return (
            f"Classified as {role!r} with {quality} confidence ({confidence:.2f}) "
            f"based on keyword overlap in task description."
        )
