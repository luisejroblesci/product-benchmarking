# Exporting a UC2 run to the eval contract

`export_evals.py` turns one run's `sessions.csv` into JSONL that `evals import`
accepts (contract 1.1, `circleci/evals` repo: `CONTRACT.md` and `docs/jsonl.md`).
One line per session: an `eval.trial` span plus one `gen_ai.evaluation.result`
event for the rubric judge. Python 3 standard library only.

## Run

```sh
python3 -I benchmarks/uc2/export_evals.py \
  --run benchmarks/uc2/runs/2026-09-23T19-04-35Z_109b0868 \
  --out /tmp/uc2-109b0868.jsonl
```

`--run` needs `sessions.csv` and (optionally) `manifest.json`. `bench.config.json`
is read from the repo root (override with `--repo-root`). Then, from a checkout
of `circleci/evals`:

```sh
go run ./cmd/evals import /tmp/uc2-109b0868.jsonl --dry-run
```

Tests: `python3 -I benchmarks/uc2/test_export_evals.py -v` (fixture: three rows
from run 109b0868 in `testdata/`, one pass, one fail, one errored session).

## What maps where

Trial span (`span` object; one per CSV row):

| UC2 column | Contract attribute | Note |
|---|---|---|
| runId | `circleci.eval.run_id` | |
| provider | `gen_ai.provider.name` | |
| providerModel (falls back to model) | `gen_ai.request.model` | exact vendor name |
| condition | `circleci.eval.condition` | cli, cli+skills, mcp, mcp+skills |
| condition | `circleci.eval.sut.name` | cli / cli+skills -> `circleci-cli`; mcp / mcp+skills -> `hosted-mcp` |
| caseId | `circleci.eval.task` and `circleci.eval.use_case` | one task per use case in UC2 |
| rep | `circleci.eval.trial` | int, 1-based |
| status | `circleci.eval.outcome` | `completed` or `error` |
| errorKind | `error.type` | only when status is not `completed` (`trial_error` if blank) |
| turns / toolCallCount / toolErrors | `circleci.eval.turns` / `tool_calls` / `tool_errors` | ints |
| inputTokens / outputTokens | `gen_ai.usage.input_tokens` / `output_tokens` | |
| cacheReadTokens / cacheWriteTokens / reasoningTokens | `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens` / `reasoning.output_tokens` | |
| costUsd | `circleci.eval.cost_usd` | plus `circleci.eval.pricing.version` = `bench.config@<sha>` |
| startedAt / endedAt | `started` / `ended` (span timestamps) | duration = ended - started; durationMs is not emitted separately |
| transcriptPath | `circleci.eval.transcript.url` | as given, relative to the run dir |
| modelTimeMs / toolTimeMs / totalTokens / firstToolTurn / retries | `circleci.eval.metric.model_time_ms` / `tool_time_ms` / `total_tokens` / `first_tool_turn` / `retries` | UC2-specific measurements, doubles |
| skillsLoaded / distinctTools | `circleci.eval.metric.skills_loaded` / `distinct_tools` | CSV holds `;`-separated names; the contract wants a double, so the **count** is emitted. The names themselves are not in the record. |
| finalAnswer, judgeReasoning | not in the span | transcript text; see verdict below |

Added by the exporter (not in the CSV):

| Attribute | Value | Source |
|---|---|---|
| `circleci.eval.suite` | `uc2` | registry id |
| `circleci.eval.polarity` | `positive` | all UC2 tasks are positive |
| `circleci.eval.harness.name` | `uc2` | registry |
| `circleci.eval.harness.version` | `product-benchmarking@<sha7>` | `manifest.json` `gitSha` (the code that produced the run); falls back to `git rev-parse HEAD`, then `unknown` |
| `circleci.eval.sut.version` | cli conditions: `manifest.json` `circleciCliVersion` (e.g. `circleci 1.0.47471 (c82f24c3bf8c)`); mcp conditions: `unknown` | manifest has no MCP server version |
| `gen_ai.operation.name` | `invoke_agent` | |

Verdict event (`events[0]`; one per row):

| Attribute | Value |
|---|---|
| `gen_ai.evaluation.name` | `rubric_score` |
| `circleci.eval.grader.kind` | `model` |
| `circleci.eval.grader.model` | judge model from `manifest.json` `config.judge.model`, else `bench.config.json` `judge.model` (`claude-opus-5-5` for run 109b0868) |
| `circleci.eval.grader.calibration` | `""` (no calibration set exists yet; the importer warns, the contract calls this non-compliant) |
| `circleci.eval.grader.version` | `uc2-judge@<bench.config version, else sha7>`; `bench.config.json` has no version field today, so it is the same sha as the harness version |
| `gen_ai.evaluation.score.value` | `score` as a double, raw 1-5 scale |
| `gen_ai.evaluation.score.label` | `pass` if `pass` is `true`, else `fail`; `skipped` (no value) when `score` is empty, i.e. the session errored before judging |
| `gen_ai.evaluation.explanation` | `judgeReasoning` truncated to 2048 bytes of UTF-8; for skipped rows, `not judged: status=error, errorKind=...` |
| suite / task / trial / run_id | repeated from the span |

## Known gaps (CSV vs contract)

- **Grader calibration**: no calibration reference exists for the judge, so
  `circleci.eval.grader.calibration` is empty. Every record gets a
  non-compliance warning on import. Fix: produce a labelled set and record its hash.
- **sut.version for MCP**: `manifest.json` does not record the hosted MCP
  server version; emitted as `unknown`. The CLI version is recorded and used.
- **No version field in `bench.config.json`**: pricing and grader versions are
  labelled with the run's git sha instead.
- **skillsLoaded / distinctTools** are lists of names in the CSV; the contract
  metric type is a double, so only counts are emitted. The names stay in the
  transcript.
- **finalAnswer** is dropped (contract: no transcript text). **judgeReasoning**
  survives only as the verdict explanation, truncated.
- **durationMs** is not emitted as its own attribute; the span duration carries it.
- Not available in the CSV, so not emitted: `gen_ai.agent.name`,
  `gen_ai.conversation.id`, `gen_ai.response.model`, `circleci.eval.grader.weight`.
- The transcript URL is a path relative to the run directory, not a fetchable
  URL; a consumer needs the repo and run dir to resolve it.
- `evals import` prints one `condition` per run in its summary line (the first
  seen); UC2 runs have four conditions per run, all present on the records.

## Dry-run result, run 109b0868 (2026-11-16)

```
$ python3 -I benchmarks/uc2/export_evals.py --run benchmarks/uc2/runs/2026-09-23T19-04-35Z_109b0868 --out /tmp/uc2-109b0868.jsonl
wrote 120 trial records (120 verdict events) to /tmp/uc2-109b0868.jsonl

$ go run ./cmd/evals import /tmp/uc2-109b0868.jsonl --dry-run
/tmp/uc2-109b0868.jsonl: 120 record(s), 1 run(s)
suite uc2  run 109b0868-1722-42cd-bc12-563902e748a2  condition cli  trials 120  grader events 120  pass 99  fail 20  partial 0  skipped 1
exit 0
```

stderr: 120 lines of `warn: ... model grader(s) without circleci.eval.grader.calibration, non-compliant: rubric_score`
(one per record, expected until a calibration set exists). The one `skipped`
verdict is the `haiku-4-5 / cli / compare-test-results-branches` session that
errored with `provider_error` (prompt too long) before judging.
