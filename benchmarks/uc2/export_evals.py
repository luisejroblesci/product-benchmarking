#!/usr/bin/env python3
"""Export a UC2 run's sessions.csv as eval-contract JSONL.

One line per session (= one eval.trial span) with one gen_ai.evaluation.result
event for the rubric judge. The output is what `evals import <file>` accepts;
see EXPORT.md next to this file for the column mapping and known gaps.

Usage:
    python3 -I export_evals.py --run benchmarks/uc2/runs/<run dir> --out trials.jsonl

Standard library only. Never writes transcript text (finalAnswer,
judgeReasoning) into the trial span; judgeReasoning goes only into the
verdict explanation, truncated to 2 KB.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

SUITE = "uc2"
HARNESS_NAME = "uc2"
GRADER_NAME = "rubric_score"
EXPLANATION_LIMIT_BYTES = 2048

# condition -> circleci.eval.sut.name
SUT_BY_CONDITION = {
    "cli": "circleci-cli",
    "cli+skills": "circleci-cli",
    "mcp": "hosted-mcp",
    "mcp+skills": "hosted-mcp",
}

# UC2 columns that are measurements, not grades: circleci.eval.metric.<key>.
# Value is a function from the raw cell to a float, or None to skip when empty.
def _count_list(cell: str) -> float | None:
    cell = cell.strip()
    if not cell:
        return 0.0
    return float(len([x for x in cell.split(";") if x.strip()]))


def _float_or_none(cell: str) -> float | None:
    cell = cell.strip()
    return float(cell) if cell else None


METRIC_COLUMNS = {
    "modelTimeMs": ("model_time_ms", _float_or_none),
    "toolTimeMs": ("tool_time_ms", _float_or_none),
    "totalTokens": ("total_tokens", _float_or_none),
    "firstToolTurn": ("first_tool_turn", _float_or_none),
    "retries": ("retries", _float_or_none),
    # list-valued in the CSV; the contract wants a double, so emit the count
    "skillsLoaded": ("skills_loaded", _count_list),
    "distinctTools": ("distinct_tools", _count_list),
}

# Columns that must never appear in the trial span (transcript text).
NEVER_IN_SPAN = ("finalAnswer", "judgeReasoning")


def _int(cell: str, default: int = 0) -> int:
    cell = (cell or "").strip()
    if not cell:
        return default
    return int(float(cell))


def _short_sha(sha: str | None) -> str | None:
    sha = (sha or "").strip()
    return sha[:7] if sha else None


def _git_short_sha(path: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--short=7", "HEAD"],
            check=True, capture_output=True, text=True,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def _load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def truncate_utf8(text: str, limit: int = EXPLANATION_LIMIT_BYTES) -> str:
    """Cut text to at most `limit` bytes of UTF-8 without splitting a code point."""
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text
    return data[:limit].decode("utf-8", errors="ignore")


class RunContext:
    """Per-run constants derived from manifest.json and bench.config.json."""

    def __init__(self, run_dir: Path, repo_root: Path | None = None):
        self.run_dir = run_dir
        self.manifest = _load_json(run_dir / "manifest.json")
        if repo_root is None:
            # benchmarks/uc2/runs/<run> -> repo root is four levels up
            repo_root = run_dir.resolve().parents[3]
        self.repo_root = repo_root
        self.bench_config = _load_json(repo_root / "bench.config.json")

        sha = _short_sha(self.manifest.get("gitSha")) or _git_short_sha(repo_root) or "unknown"
        self.code_sha = sha
        self.harness_version = f"product-benchmarking@{sha}"
        # bench.config.json carries no version field; fall back to the code sha
        config_version = self.bench_config.get("version") or self.manifest.get("config", {}).get("version")
        self.grader_version = f"uc2-judge@{config_version or sha}"
        self.pricing_version = f"bench.config@{sha}"

        judge = (self.manifest.get("config", {}).get("judge")
                 or self.bench_config.get("judge") or {})
        self.judge_model = judge.get("model") or "unknown"

        self.cli_version = (self.manifest.get("circleciCliVersion") or "").strip() or "unknown"
        self.mcp_version = (self.manifest.get("mcpVersion") or "").strip() or "unknown"

    def sut_version(self, condition: str) -> str:
        if condition.startswith("cli"):
            return self.cli_version
        return self.mcp_version


def build_record(row: dict, ctx: RunContext) -> dict:
    condition = row["condition"].strip()
    if condition not in SUT_BY_CONDITION:
        raise ValueError(f"unknown condition {condition!r}")

    suite_keys = {
        "circleci.eval.suite": SUITE,
        "circleci.eval.task": row["caseId"].strip(),
        "circleci.eval.trial": _int(row["rep"], 1),
        "circleci.eval.run_id": row["runId"].strip(),
    }

    span = dict(suite_keys)
    span.update({
        "circleci.eval.condition": condition,
        "circleci.eval.use_case": row["caseId"].strip(),
        "circleci.eval.polarity": "positive",
        "circleci.eval.sut.name": SUT_BY_CONDITION[condition],
        "circleci.eval.sut.version": ctx.sut_version(condition),
        "circleci.eval.harness.name": HARNESS_NAME,
        "circleci.eval.harness.version": ctx.harness_version,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": row["provider"].strip() or "unknown",
        "gen_ai.request.model": row["providerModel"].strip() or row["model"].strip() or "unknown",
        "gen_ai.usage.input_tokens": _int(row["inputTokens"]),
        "gen_ai.usage.output_tokens": _int(row["outputTokens"]),
        "circleci.eval.turns": _int(row["turns"]),
        "circleci.eval.tool_calls": _int(row["toolCallCount"]),
    })

    for col, key in (
        ("cacheReadTokens", "gen_ai.usage.cache_read.input_tokens"),
        ("cacheWriteTokens", "gen_ai.usage.cache_creation.input_tokens"),
        ("reasoningTokens", "gen_ai.usage.reasoning.output_tokens"),
        ("toolErrors", "circleci.eval.tool_errors"),
    ):
        if row.get(col, "").strip():
            span[key] = _int(row[col])

    if row.get("costUsd", "").strip():
        span["circleci.eval.cost_usd"] = float(row["costUsd"])
        span["circleci.eval.pricing.version"] = ctx.pricing_version

    if row.get("transcriptPath", "").strip():
        span["circleci.eval.transcript.url"] = row["transcriptPath"].strip()

    status = row.get("status", "").strip()
    if status:
        span["circleci.eval.outcome"] = status
    if status and status != "completed":
        span["error.type"] = row.get("errorKind", "").strip() or "trial_error"

    for col, (key, conv) in METRIC_COLUMNS.items():
        if col in row:
            value = conv(row[col] or "")
            if value is not None:
                span[f"circleci.eval.metric.{key}"] = value

    for col in NEVER_IN_SPAN:
        assert col not in span

    verdict = dict(suite_keys)
    verdict.update({
        "gen_ai.evaluation.name": GRADER_NAME,
        "circleci.eval.grader.kind": "model",
        "circleci.eval.grader.model": ctx.judge_model,
        "circleci.eval.grader.calibration": "",
        "circleci.eval.grader.version": ctx.grader_version,
    })
    score = row.get("score", "").strip()
    if score:
        verdict["gen_ai.evaluation.score.value"] = float(score)
        verdict["gen_ai.evaluation.score.label"] = (
            "pass" if row.get("pass", "").strip().lower() == "true" else "fail"
        )
        reasoning = (row.get("judgeReasoning") or "").strip()
        if reasoning:
            verdict["gen_ai.evaluation.explanation"] = truncate_utf8(reasoning)
    else:
        verdict["gen_ai.evaluation.score.label"] = "skipped"
        why = f"not judged: status={status or 'unknown'}"
        kind = row.get("errorKind", "").strip()
        if kind:
            why += f", errorKind={kind}"
        verdict["gen_ai.evaluation.explanation"] = why

    return {
        "name": "eval.trial",
        "started": row["startedAt"].strip(),
        "ended": row["endedAt"].strip(),
        "span": span,
        "events": [verdict],
        "event_name": "gen_ai.evaluation.result",
    }


def export(run_dir: Path, out_path: Path, repo_root: Path | None = None) -> int:
    ctx = RunContext(run_dir, repo_root)
    csv_path = run_dir / "sessions.csv"
    n = 0
    with csv_path.open(newline="", encoding="utf-8") as src, out_path.open("w", encoding="utf-8") as dst:
        for i, row in enumerate(csv.DictReader(src), start=2):
            try:
                record = build_record(row, ctx)
            except (KeyError, ValueError) as exc:
                raise SystemExit(f"{csv_path}:{i}: {exc}") from exc
            dst.write(json.dumps(record, ensure_ascii=False) + "\n")
            n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--run", required=True, type=Path, help="run directory containing sessions.csv and manifest.json")
    ap.add_argument("--out", required=True, type=Path, help="output JSONL path")
    ap.add_argument("--repo-root", type=Path, default=None,
                    help="repo root holding bench.config.json (default: four levels above --run)")
    args = ap.parse_args(argv)

    if not (args.run / "sessions.csv").is_file():
        ap.error(f"{args.run / 'sessions.csv'} not found")
    n = export(args.run, args.out, args.repo_root)
    print(f"wrote {n} trial records ({n} verdict events) to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
