# product-benchmarking

A TypeScript CLI that benchmarks how well LLM agents perform real CircleCI developer workflows, and whether giving them different tools — the `circleci` CLI, the hosted CircleCI MCP server, and/or [CircleCI-Public/skills](https://github.com/CircleCI-Public/skills) guidance — changes their success rate, judged quality, and, importantly, **how many turns and tool calls they need to get there**.

Two benchmarks live here:

- **UC1 (`sidecar`)** — apples-to-apples speed comparison between a `chunk` sidecar run and a traditional CI pipeline run, on real commits.
- **UC2 (`usecases`)** — the main focus of this repo. 10 real developer workflow prompts, run against 3 Claude models (Opus 5.5, Sonnet 5, Haiku 4.5 today; OpenAI/Gemini/OpenRouter adapters are already wired in but disabled pending real model IDs) across 4 tool-access conditions, scored by an LLM judge against a rubric.

## Quickstart

Requires Node 22 (matches `cimg/node:22.0` in CI).

```bash
npm ci
cp .env.example .env
```

Fill in `.env` with only the keys you need:

| Var | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude models, and the default LLM judge |
| `OPENAI_API_KEY` | the currently-disabled `openai-example` model slot |
| `GOOGLE_GENERATIVE_AI_API_KEY` | the currently-disabled `gemini-example` model slot |
| `OPENROUTER_API_KEY` | the currently-disabled `openrouter-example` model slot |
| `CIRCLECI_TOKEN` | authenticates both the `circleci` CLI tool surface and the hosted CircleCI MCP server |

There's no build/test step — everything runs directly via `tsx`. A few subcommands have npm script wrappers; the rest you invoke directly:

```bash
npm run bench:usecases   # -> tsx src/cli.ts usecases
npm run bench:sidecar    # -> tsx src/cli.ts sidecar
npm run bench:preflight  # -> tsx src/cli.ts preflight
npm run report           # -> tsx src/cli.ts report

# no npm wrapper for these — call directly:
npx tsx src/cli.ts inspect <runDir>
npx tsx src/cli.ts judge <runDir>
npx tsx src/cli.ts finalize <runDir>
npx tsx src/cli.ts serve <runDir>
```

Example runs:

```bash
# UC2: a couple of models, two conditions, two cases, 2 reps each
npx tsx src/cli.ts usecases --models sonnet-5,haiku-4-5 --conditions "cli,mcp" \
  --cases diagnose-failed-build,find-flaky-tests --reps 2 --no-ui

# UC1: sidecar vs CI speed over the last 10 commits on main
npx tsx src/cli.ts sidecar --repo luisejroblesci/circleci-cli \
  --repo-dir ~/code/circleci-cli --n 10 --no-ui
```

## File structure

```
.circleci/config.yml              CI pipeline that runs the usecases benchmark
.env.example                      template for required API keys/tokens
bench.config.json                 models, conditions, judge, skills/mcp/cli/target config, pricing
benchmarks/uc2/                   UC2 run outputs — versioned in git (see "Where results are stored")
results/                          UC1 run outputs — gitignored, local only
suites/circleci-use-cases.json    the 10 UC2 use cases (prompt + rubric each)
src/
├── cli.ts                        Commander entrypoint: sidecar, usecases, preflight, inspect, judge, finalize, serve, report
├── core/                         config loading, shared types, storage, report/summary generation
├── benchmarks/
│   ├── sidecar/                  UC1 implementation (chunk sidecar vs CI pipeline timing)
│   └── skills/                   UC2 implementation: agent loop, providers, judge, preflight, skills-loader, workspace, tools/
└── ui/server.ts                  live SSE dashboard shown during runs (unless --no-ui)
```

### `src/cli.ts` subcommands

| Command | Purpose | Key flags |
|---|---|---|
| `usecases` | Run the UC2 benchmark | `--models`, `--conditions`, `--cases`, `--reps`, `--concurrency`, `--out`, `--resume <runDir>`, `--retry-errors`, `--skip-preflight`, `--no-ui` |
| `sidecar` | Run the UC1 benchmark | `--repo`, `--ci-repo`, `--repo-dir`, `--branch`, `--n`, `--commits`, `--out`, `--no-ui` |
| `preflight` | Verify every configured model + tool surface works, without running evals | `--config`, `--suite`, `--models`, `--conditions` |
| `inspect <runDir>` | Print turn-by-turn timelines for sessions in a run | `--model`, `--condition`, `--case`, `--rep` |
| `judge <runDir>` | Re-grade sessions whose judge call failed (or all, with `--all`) | `--config`, `--suite`, `--all` |
| `finalize <runDir>` | Regenerate `summary.json`/`report.html`/`sessions.csv` from `sessions.jsonl` | — |
| `serve <runDir>` | Serve a run directory so `report.html` and the transcript viewer work in a browser | `--port` |
| `report` | Generate an HTML report from a saved UC1 run JSON | `--runs`, `--title`, `--out` |

## UC2 conditions

Every use case is run under 4 tool-access conditions so we can isolate the effect of skills and MCP:

| Condition | Means |
|---|---|
| `cli` | raw `circleci` CLI only |
| `cli+skills` | `circleci` CLI + CircleCI-Public/skills guidance |
| `mcp` | hosted CircleCI MCP server only |
| `mcp+skills` | MCP + skills guidance |

## Use cases: what each one solves

Each case in `suites/circleci-use-cases.json` is a realistic prompt plus a rubric the LLM judge grades against — designed to catch fabrication (invented job names, test names, URLs, timestamps) as much as wrong answers.

### `diagnose-failed-build`
> "Why did my last build on the main branch fail?"

Tests whether the agent finds the actual most recent failed run on `main`, names the real failing job and quotes the real error from logs, and gives a fix grounded in that evidence rather than a generic list of possible causes.

```bash
npx tsx src/cli.ts usecases --cases diagnose-failed-build
```

### `find-flaky-tests`
> "Which tests in my project have been flaky over the past 30 days?"

Tests whether the agent inspects multiple recent runs (not just one) and correctly distinguishes flaky (intermittent) tests from consistently-failing ones, naming real tests instead of inventing flaky ones.

```bash
npx tsx src/cli.ts usecases --cases find-flaky-tests
```

### `monitor-pipeline-status`
> "Show me the current pipeline status for all my followed projects."

Tests whether the agent reports accurate current run/workflow status (branch, ID, time) for at least the target project, clearly flags failing/running items, and is honest about not being able to enumerate every followed project.

```bash
npx tsx src/cli.ts usecases --cases monitor-pipeline-status
```

### `optimize-resource-usage`
> "Are any of my jobs using larger resource classes than they need?"

Tests whether resource-class recommendations are grounded in real job/usage data (durations, parallelism, credits) rather than fabricated sizing or cost figures.

```bash
npx tsx src/cli.ts usecases --cases optimize-resource-usage
```

### `rerun-failed-workflow`
> "Rerun just the failed jobs in my latest workflow."

Tests whether the agent correctly identifies the latest workflow, determines whether it has failed jobs, and performs (or precisely proposes) a rerun-from-failed — without rerunning the whole workflow, rerunning/cancelling an unrelated one, or claiming a rerun happened when it didn't.

```bash
npx tsx src/cli.ts usecases --cases rerun-failed-workflow
```

### `retrieve-build-artifacts`
> "Download the test coverage report from my last successful build."

Tests whether the agent locates the real most-recent successful run, inspects its actual artifacts, and either provides the genuine coverage artifact path/URL or honestly reports none exists — never a fabricated URL.

```bash
npx tsx src/cli.ts usecases --cases retrieve-build-artifacts
```

### `audit-recent-deployments`
> "What deployments went out to production this week and who triggered them?"

Tests whether the agent examines the last ~7 days of runs/workflows, correctly identifies which are production deployments, and reports real timestamps, status, and triggering actors — or honestly states none were found.

```bash
npx tsx src/cli.ts usecases --cases audit-recent-deployments
```

### `debug-slow-pipeline`
> "Which jobs in my pipeline are taking the longest and why?"

Tests whether the agent ranks jobs by real measured durations, explains slowness using actual evidence (step timings, config, queueing) rather than generic speculation, and gives concrete, evidence-tied optimization suggestions.

```bash
npx tsx src/cli.ts usecases --cases debug-slow-pipeline
```

### `validate-config`
> "Can you check if my CircleCI config is valid and suggest improvements?"

Tests whether the agent actually validates (or gathers real evidence of) the target project's config validity and gives specific improvement suggestions grounded in the project's real jobs/workflows/orbs, rather than inventing config contents.

```bash
npx tsx src/cli.ts usecases --cases validate-config
```

### `compare-test-results-branches`
> "Did my feature branch introduce any new test failures compared to main?"

Tests whether the agent identifies a real non-main branch, compares actual test/job results between that branch's latest run and main's, and correctly distinguishes new regressions from pre-existing failures rather than fabricating branches or tests.

```bash
npx tsx src/cli.ts usecases --cases compare-test-results-branches
```

## How to contribute

**A new use case** — add a case object to `suites/circleci-use-cases.json`:

```json
{
  "id": "your-case-id",
  "prompt": "The exact user-facing prompt.",
  "tags": ["short", "tags"],
  "expected": "A sentence describing what a correct answer looks like.",
  "rubric": ["Specific, checkable criteria the judge scores against."]
}
```

Run it in isolation to sanity-check the judge behaves sensibly before opening a PR:

```bash
npx tsx src/cli.ts usecases --cases your-case-id --reps 1
```

**A new model/provider** — add an entry to the `models` array in `bench.config.json`:

```json
{ "id": "my-model", "provider": "anthropic", "model": "claude-...", "apiKeyEnv": "ANTHROPIC_API_KEY" }
```

`provider` must be one of `anthropic`, `openai`, `google`, `openai-compatible`. Three example entries (`openai-example`, `gemini-example`, `openrouter-example`) are already staged with `enabled: false` — flip `enabled: true` and fill in the real `model` id once you have one. Add the corresponding key to `.env`, then run `npx tsx src/cli.ts preflight` to confirm the new model can actually make tool calls before including it in a full run.

**A new suite** — create a JSON file with the same shape as `suites/circleci-use-cases.json` and pass it via `--suite <file>`.

## Interpreting results — turns matter as much as pass rate

`summary.json` (per run) has one cell per model × condition, with these key fields:

- **`passRate`, `meanScore`** — correctness: whether the LLM judge scored the session as passing the rubric, and its 1–5 score.
- **`avgTurns`, `avgToolCalls`, `avgToolErrors`** — **efficiency**: how many turns and tool calls the agent needed to get there, and how often those tool calls errored. This has been the single most revealing signal across runs so far — it's often where skills/MCP help or hurt even when pass rate looks flat. For example, in the latest run, skills cut Sonnet 5's average turns from 11.1 (`cli`) to 8.1 (`cli+skills`) at an equal-or-better score, while for Opus 5.5 skills *raised* turns from 8.2 to 10.6 with no score gain — the same condition can be a clear efficiency win for one model and pure overhead for another.
- **`p50DurationMs`, `p90DurationMs`** — wall-clock duration.
- **`skillsDelta`** (end of `summary.json`) — per-model, per-surface (`cli` vs `mcp`) deltas in pass rate, score, and tokens when skills are added — the fastest way to see whether skills paid for themselves for a given model.

To dig past the summary:

```bash
npx tsx src/cli.ts serve benchmarks/uc2/runs/<run>          # visual report.html table
npx tsx src/cli.ts inspect benchmarks/uc2/runs/<run> \
  --model sonnet-5 --condition cli+skills --case find-flaky-tests   # turn-by-turn transcript
```

## Where results are stored

- **UC2 (`benchmarks/uc2/`)** — versioned in git, *not* gitignored. `index.jsonl` is the cross-run rollup index. Each `runs/<timestamp>_<hash>/` directory holds:
  - `manifest.json` — full config/provenance snapshot (git SHA, suite hash, skills ref, resolved config, preflight results)
  - `summary.json` — per model×condition stats plus `skillsDelta`
  - `sessions.jsonl` / `sessions.csv` — one record per session (model, condition, case, rep, score, turns, tokens, tool calls, etc.)
  - `report.html` / `transcript.html` — viewable via `bench serve <runDir>`
  - `transcripts/<model>/<condition>/<case>.r<rep>.jsonl` — raw per-session tool-call transcripts, the data behind `bench inspect`

  Also uploaded as the `benchmark-results` CircleCI artifact on every CI run. See a real example at [`benchmarks/uc2/runs/2026-09-23T19-04-35Z_109b0868/summary.json`](benchmarks/uc2/runs/2026-09-23T19-04-35Z_109b0868/summary.json).

- **UC1 (`results/`)** — gitignored, local only. Generate its HTML report with `npx tsx src/cli.ts report --runs <file>`.

## Running in CI

`.circleci/config.yml` defines a `usecases-benchmark` job with pipeline parameters `models`, `conditions`, `cases`, and `reps` that map directly to the matching CLI flags — so a targeted run can be triggered from the CircleCI UI without touching YAML. Results are uploaded as the `benchmark-results` artifact from `benchmarks/uc2`.

## Known limitations

Across every model and condition tested so far, `find-flaky-tests` and `debug-slow-pipeline` are consistently the hardest cases — worth keeping in mind when tuning skills content or the judge rubric.
