"""Tests for interchange.router — classification, constraint filtering, edge cases."""
from __future__ import annotations

import pytest

from interchange.exceptions import RoutingError
from interchange.models import Role, RouteConstraints
from interchange.router import Router


@pytest.fixture
def router_with_all_roles():
    return Router(
        roles={
            "planner": Role(
                preferred_model="claude-opus-4-6",
                fallback_model="gpt-4o",
                capabilities=["plan", "design", "architect", "strategy"],
            ),
            "coder": Role(
                preferred_model="gpt-4o",
                fallback_model="claude-sonnet-4-6",
                capabilities=["implement", "code", "write", "test", "debug"],
            ),
            "reviewer": Role(
                preferred_model="claude-sonnet-4-6",
                fallback_model="gpt-4o-mini",
                capabilities=["review", "check", "audit", "validate"],
            ),
            "researcher": Role(
                preferred_model="gemini-2.0-flash",
                fallback_model="claude-sonnet-4-6",
                capabilities=["research", "find", "analyze", "summarize"],
            ),
        }
    )


class TestClassification:
    def test_routes_coding_task_to_coder(self, router_with_all_roles):
        decision = router_with_all_roles.route("implement a REST API endpoint")
        assert decision.role == "coder"

    def test_routes_planning_task_to_planner(self, router_with_all_roles):
        decision = router_with_all_roles.route("design the architecture for our system")
        assert decision.role == "planner"

    def test_routes_review_task_to_reviewer(self, router_with_all_roles):
        decision = router_with_all_roles.route("review and audit the auth code")
        assert decision.role == "reviewer"

    def test_routes_research_task_to_researcher(self, router_with_all_roles):
        decision = router_with_all_roles.route("research and analyze options for caching")
        assert decision.role == "researcher"

    def test_confidence_is_between_0_and_1(self, router_with_all_roles):
        decision = router_with_all_roles.route("write a function")
        assert 0.0 <= decision.confidence <= 1.0

    def test_unmatched_task_returns_a_role(self, router_with_all_roles):
        # Even with no keyword matches, should return some role
        decision = router_with_all_roles.route("xyzzy quux blargh")
        assert decision.role in router_with_all_roles.roles

    def test_rationale_is_non_empty(self, router_with_all_roles):
        decision = router_with_all_roles.route("implement something")
        assert decision.rationale


class TestForceRole:
    def test_force_role_bypasses_classification(self, router_with_all_roles):
        decision = router_with_all_roles.route("plan something", force_role="coder")
        assert decision.role == "coder"
        assert decision.confidence == 1.0

    def test_force_unknown_role_raises(self, router_with_all_roles):
        with pytest.raises(RoutingError, match="not in registry"):
            router_with_all_roles.route("task", force_role="nonexistent_role")


class TestConstraints:
    def test_prefers_preferred_model_by_default(self, router_with_all_roles):
        decision = router_with_all_roles.route("implement a feature")
        assert decision.model == "gpt-4o"  # coder's preferred

    def test_falls_back_when_preferred_disallowed(self, router_with_all_roles):
        constraints = RouteConstraints(disallowed_models=["gpt-4o"])
        decision = router_with_all_roles.route(
            "implement a feature", constraints=constraints
        )
        assert decision.model == "claude-sonnet-4-6"

    def test_cost_constraint_selects_cheaper_model(self, router_with_all_roles):
        # claude-opus-4-6 costs 0.015, gpt-4o costs 0.005
        # planner's preferred is claude-opus-4-6, fallback is gpt-4o
        constraints = RouteConstraints(max_cost_usd_per_1k_tokens=0.010)
        decision = router_with_all_roles.route(
            "plan the project", constraints=constraints, force_role="planner"
        )
        assert decision.model == "gpt-4o"  # falls back to cheaper model

    def test_no_models_survive_constraints_raises(self, router_with_all_roles):
        constraints = RouteConstraints(
            disallowed_models=["claude-opus-4-6", "gpt-4o"]
        )
        with pytest.raises(RoutingError, match="No model available"):
            router_with_all_roles.route(
                "plan something", constraints=constraints, force_role="planner"
            )

    def test_zero_cost_constraint_raises_for_expensive_models(self, router_with_all_roles):
        constraints = RouteConstraints(max_cost_usd_per_1k_tokens=0.0)
        with pytest.raises(RoutingError):
            router_with_all_roles.route(
                "plan something", constraints=constraints, force_role="planner"
            )


class TestEdgeCases:
    def test_single_role_registry(self):
        router = Router(
            roles={
                "only_role": Role(
                    preferred_model="gpt-4o-mini",
                    fallback_model="gpt-4o-mini",
                    capabilities=["anything"],
                )
            }
        )
        decision = router.route("do something")
        assert decision.role == "only_role"

    def test_empty_roles_raises(self):
        with pytest.raises(ValueError, match="At least one role"):
            Router(roles={})

    def test_route_returns_route_decision(self, router):
        from interchange.models import RouteDecision

        decision = router.route("code something")
        assert isinstance(decision, RouteDecision)
