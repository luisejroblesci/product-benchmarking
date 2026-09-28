# Use case: stop broken agent code from flooding CI

**Source:** `chunk.ai value props and use cases` doc, value prop 1.

**Persona:** individual developer using AI coding agents.

**The pain:** *"My agent keeps pushing broken code and CI is full of noise."*
AI coding agents commit fast but make frequent errors (broken imports,
missing dependencies, syntax issues). These failures flood CI pipelines,
waste compute, and create noise that slows the whole team.

**What Chunk does about it:** `chunk validate --remote` runs the project's
lint/test gate on a sidecar — a CI-matched cloud microVM — before anything is
pushed. A broken change gets caught and fixed in the loop, never reaching the
shared pipeline.

**Benefit to the user:** the developer (or their agent) gets pass/fail
feedback fast enough to fix-and-retry, without waiting in a CI queue and
without adding noise to a pipeline other developers share.

## Feasibility verdict: **Validated**

Demonstrated end-to-end against a real sidecar for
[`calculator-app`](https://github.com/luisejroblesci/calculator-app/tree/luisejroblescci-demo/agent-code-validation)
— see that branch's `DEMO.md` for the full walkthrough and `AGENT.md` for
agent-replayable instructions.

## What we actually measured

| Step | Result | Wall-clock |
|---|---|---|
| First sync + validate (clean repo) | ✓ 2/2 passed | 17.1s |
| Validate after injecting a deliberately broken test | ✗ failed on `test` gate | 7.2s |
| Validate after fixing it | ✓ 2/2 passed | 8.0s |

Re-running the same sequence via `calculator-app`'s `bench.sh` produced
consistent ~7–8s validate times (baseline 7.9s, broken 7.5s, fixed 7.5s) —
see `calculator-app`'s `results/*.json` on that branch.

No new `chunk-cli` functionality was needed for this use case — everything
used is already documented in `chunk-cli/docs/GETTING_STARTED.md` ("Sidecar
workflow") and the `commands` schema in `.chunk/config.json`. The only gap
was in the target app itself: `calculator-app` had zero tests before this
work, so there was nothing to validate.

## Setup (condensed from calculator-app's DEMO.md)

```bash
chunk auth status                 # confirm CircleCI auth
chunk sidecar current             # confirm/activate a sidecar (chunk sidecar setup if none)
chunk validate --remote           # runs lint + test gate on the sidecar
```

## Repeatability

`calculator-app`'s `bench.sh` (on the `luisejroblescci-demo/agent-code-validation`
branch) reruns the full baseline → inject bug → fix sequence and writes
timings to `results/<timestamp>.json` on demand.

This repo's own `sidecar` benchmark (`npm run bench:sidecar`) — the tool
behind the original "27s microbuild vs minutes" claim — was generalized as
part of this work (`src/benchmarks/sidecar/chunk.ts`) to stop hardcoding the
`circleci-cli` repo name and Go runtime check, so it can in principle target
any repo with a `.chunk/config.json`, including `calculator-app`, via:

```bash
npm run bench:sidecar -- --repo luisejroblesci/calculator-app --repo-dir <path-to-calculator-app> --n 5
```

**Not yet run for calculator-app**: this benchmark compares sidecar timing
against *historical CI pipeline durations* fetched from CircleCI for real
commits on `main`. `calculator-app`'s `.circleci/config.yml` only exists on
the demo branch so far, not on `main`, so there's no CI history yet to
compare against. Once the demo branch (or an equivalent CI setup) lands on
`main` and a few pipeline runs have happened, this command will produce a
real sidecar-vs-CI speedup number for calculator-app the same way it already
does for `circleci-cli`.
