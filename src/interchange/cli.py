"""interchange CLI — run tasks from the command line."""
from __future__ import annotations

import asyncio
import json
import os

import click

from .core import Interchange
from .models import Role, RouteConstraints


@click.group()
def cli() -> None:
    """interchange — multi-model agent orchestrator."""


@cli.command()
@click.argument("task")
@click.option("--state-backend", default="sqlite", show_default=True,
              type=click.Choice(["memory", "sqlite"]),
              help="State persistence backend.")
@click.option("--state-path", default="~/.interchange/state.db", show_default=True,
              help="Path to SQLite database.")
@click.option("--max-cost", default=None, type=float,
              help="Max cost per 1k tokens (USD). Filters models above this threshold.")
@click.option("--json", "output_json", is_flag=True, default=False,
              help="Output full result as JSON.")
def run(
    task: str,
    state_backend: str,
    state_path: str,
    max_cost: float | None,
    output_json: bool,
) -> None:
    """Decompose and run TASK across multiple models."""
    ix = Interchange(state_backend=state_backend, state_path=state_path)
    constraints = RouteConstraints(max_cost_usd_per_1k_tokens=max_cost) if max_cost else None

    result = asyncio.run(ix.run(task, constraints=constraints))

    if output_json:
        click.echo(_result_to_json(result))
    else:
        _print_result(result)


@cli.command("run-as")
@click.argument("role")
@click.argument("task")
@click.option("--model", default=None, help="Override the model for this role.")
@click.option("--state-backend", default="sqlite", show_default=True,
              type=click.Choice(["memory", "sqlite"]))
@click.option("--state-path", default="~/.interchange/state.db", show_default=True)
@click.option("--json", "output_json", is_flag=True, default=False)
def run_as(
    role: str,
    task: str,
    model: str | None,
    state_backend: str,
    state_path: str,
    output_json: bool,
) -> None:
    """Run TASK with an explicit ROLE (single step, no decomposition)."""
    ix = Interchange(state_backend=state_backend, state_path=state_path)
    result = asyncio.run(ix.run_as(role=role, task=task, model_override=model))

    if output_json:
        click.echo(_result_to_json(result))
    else:
        _print_result(result)


@cli.command()
@click.argument("task_id")
@click.option("--state-backend", default="sqlite", show_default=True,
              type=click.Choice(["memory", "sqlite"]))
@click.option("--state-path", default="~/.interchange/state.db", show_default=True)
def status(task_id: str, state_backend: str, state_path: str) -> None:
    """Show the status of a task by TASK_ID."""
    ix = Interchange(state_backend=state_backend, state_path=state_path)
    try:
        state = ix.state.get(task_id)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)

    click.echo(f"Task:   {state.original_task}")
    click.echo(f"Status: {state.status}")
    click.echo(f"Nodes:  {len(state.task_nodes)}")
    for node in state.task_nodes.values():
        model_info = f" [{node.assigned_model}]" if node.assigned_model else ""
        click.echo(f"  {node.id} ({node.role}){model_info}: {node.status}")


@cli.command()
@click.option("--state-backend", default="sqlite", show_default=True,
              type=click.Choice(["memory", "sqlite"]))
@click.option("--state-path", default="~/.interchange/state.db", show_default=True)
def list_tasks(state_backend: str, state_path: str) -> None:
    """List all known task IDs."""
    ix = Interchange(state_backend=state_backend, state_path=state_path)
    task_ids = ix.state.list_tasks()
    if not task_ids:
        click.echo("No tasks found.")
        return
    for tid in task_ids:
        click.echo(tid)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _print_result(result: object) -> None:
    from .models import InterchangeResult

    if not isinstance(result, InterchangeResult):
        click.echo(str(result))
        return

    click.echo(f"\n{'='*60}")
    click.echo(f"Task ID: {result.task_id}")
    click.echo(f"Status:  {result.status}")
    click.echo(f"Time:    {result.wall_time_ms}ms  |  Tokens: {result.total_tokens}")
    click.echo(f"{'='*60}")

    if result.task_nodes:
        click.echo("\nTask Graph:")
        for node in result.task_nodes:
            model_info = f" [{node.assigned_model}]" if node.assigned_model else ""
            click.echo(f"  [{node.status}] {node.id} ({node.role}){model_info}")
            click.echo(f"    {node.description[:80]}")

    if result.tool_calls:
        click.echo(f"\nTool Calls ({len(result.tool_calls)}):")
        for tc in result.tool_calls:
            click.echo(f"  {tc.name}({_truncate(str(tc.inputs), 60)})")

    click.echo(f"\nOutput:\n{result.output}")


def _result_to_json(result: object) -> str:
    from .models import InterchangeResult

    if not isinstance(result, InterchangeResult):
        return json.dumps({"output": str(result)})

    return json.dumps(
        {
            "task_id": result.task_id,
            "status": result.status,
            "output": result.output,
            "wall_time_ms": result.wall_time_ms,
            "total_tokens": result.total_tokens,
            "task_nodes": [
                {
                    "id": n.id,
                    "role": n.role,
                    "model": n.assigned_model,
                    "status": n.status,
                    "description": n.description,
                }
                for n in result.task_nodes
            ],
        },
        indent=2,
    )


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"
