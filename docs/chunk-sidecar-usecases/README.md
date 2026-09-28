# Chunk sidecar use cases: feasibility summary

Written for PMM/sales. Source doc: `chunk.ai value props and use cases`.
Validated against real `chunk` sidecars using
[`calculator-app`](https://github.com/luisejroblesci/calculator-app) as the
demo repo. Each use case has its own writeup in this folder, plus a matching
`luisejroblescci-demo/<use-case>` branch in both `calculator-app` (the
runnable demo: `DEMO.md`, `AGENT.md`, `bench.sh`) and this repo (this
writeup).

## Feasibility matrix

| Use case | Verdict | Real number captured | Repeatable? |
|---|---|---|---|
| [Stop broken agent code from flooding CI](agent-code-validation.md) | **Validated** | `chunk validate --remote` catches a broken change in ~7s; clean run ~8–17s | Yes — `bench.sh` in calculator-app, and this repo's generalized `bench:sidecar` tool |
| [Run what you can't run locally](local-workload-offload.md) | **Validated, with a gap** | Postgres-backed integration test passes remotely in ~8–9s, no local DB/Docker | Yes — `bench.sh`, but Postgres provisioning is a manual step, not durable setup |
| [Delegate the grunt work to an agent](agent-task-delegation.md) | **Mechanism validated; agent-in-the-loop not validated** | One-shot `chunk sidecar exec` task completes in ~0.6–0.7s | Yes — `bench.sh`, but only for the deterministic stand-in task |

## What's missing for PMM/sales

### Solved by this work

- **Repeatability for use cases 2 and 3.** Each `calculator-app` demo branch
  ships a `bench.sh` that reruns the demo and writes real timings to
  `results/<timestamp>.json` on demand — not a one-time claim. Use case 1
  additionally got the existing `bench:sidecar` benchmark (the tool behind
  the original "27s microbuild" number) generalized so it isn't hardcoded to
  the `circleci-cli` repo anymore.
- **A way to replicate demos without a recording.** Each demo branch has an
  `AGENT.md` — explicit, checkpointed instructions an AI agent can follow to
  run the whole demo unattended and report real results, instead of relying
  on a pre-recorded video that goes stale as the CLI changes.
- **An objection-handling FAQ.** See [FAQ.md](FAQ.md).

### Explicitly flagged, not built now

- **Competitor benchmarking.** We have not benchmarked Chunk against local
  Docker Compose stacks, GitHub Codespaces/devcontainers, or similar, because
  the current strategy positions Chunk as a one-stop shop rather than winning
  head-to-head comparisons. **This should be prioritized soon** — sales will
  get "why not just use X" questions regardless of positioning strategy, and
  right now there's no data to answer with.
- **Pricing/packaging for sidecars.** There is no billing/metering model yet
  for sidecar usage. Sales will hit this question immediately after any demo
  lands; this work doesn't attempt to answer it.

### Explicitly out of scope right now (per product direction)

- **Security/compliance one-pager.** Not needed at this stage — the current
  goal is opening new business lines, not enterprise compliance readiness.

## Real product gaps this work surfaced

These came out of actually running the demos, not from reading docs:

1. **Custom `environment.setup` steps don't survive `chunk sidecar setup
   --force` / `chunk sidecar env` re-detection.** Adding a manual step (e.g.
   installing Postgres) works until auto-detection runs again, at which
   point it's silently dropped. See [local-workload-offload.md](local-workload-offload.md).
2. **`chunk sidecar ssh -- cat <path>`** — the exact form shown in
   `chunk-cli/docs/GETTING_STARTED.md`'s lock-file example — failed with
   `invalid argument` in our run. `chunk sidecar exec --command cat --args
   <path>` worked reliably instead. See [agent-task-delegation.md](agent-task-delegation.md).
3. **No durable way to declare a backing service** (Postgres, Redis, etc.) as
   part of project setup — sidecars can clearly run one (full Linux, `sudo`
   available), but nothing in `chunk init`/`chunk sidecar setup` captures
   "this project also needs X" the way it captures the language/test-runner
   stack.

None of these block the pitch — all three demos work — but they're worth
routing to the chunk-cli team before a customer hits them live.
