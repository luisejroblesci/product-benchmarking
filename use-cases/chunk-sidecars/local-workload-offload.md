# Use case: run what you can't run locally

**Source:** `chunk.ai value props and use cases` doc, value prop 2.

**Persona:** developer.

**The pain:** *"I can't run the integration tests locally, I don't have the
services or my laptop can't handle it."* Integration suites that need
Postgres, Redis, or a queue service fight over local ports with other
projects; ML training needs more compute than a laptop has; end-to-end tests
need a full service stack only available in staging or CI.

**What Chunk does about it:** a sidecar gives a full cloud environment in one
command — spin up the backing services, run the workload, get the result,
without touching the local setup.

**Benefit to the user:** the check doesn't get skipped, and you don't wait in
a CI queue just to find out if a change works against a real service.

## Feasibility verdict: **Validated, with a real product gap**

Demonstrated end-to-end against a real sidecar for
[`calculator-app`](https://github.com/luisejroblesci/calculator-app/tree/luisejroblescci-demo/local-workload-offload)
— a minimal Node "calculation history" HTTP API backed by a real Postgres
database, with a real integration test (no mocks). See that branch's
`DEMO.md` for the full walkthrough and `AGENT.md` for agent-replayable
instructions.

The demo was run on a machine with **no Docker daemon even running locally**
— which is itself supporting evidence for the pain point being described.

## What we actually measured

| Step | Result | Wall-clock |
|---|---|---|
| `chunk validate --remote` (migrate + Postgres integration test) | ✓ 2/2 passed | 9.1s |
| Repeated via `bench.sh` (2 runs) | ✓ both passed | 7.7s, 8.0s |

The integration test itself (HTTP round-trip through a real Postgres row)
took ~125ms once inside the sidecar — nearly all of the wall-clock time is
sync + process startup, not database work.

## The real gap this surfaced

**`chunk sidecar setup --force` / `chunk sidecar env` auto-detect the tech
stack and regenerate `environment.setup` — overwriting any manually added
step**, such as the `postgres` install/provisioning step this demo needed.
Provisioning Postgres had to be done by hand via `chunk sidecar exec`
*outside* the normal setup flow, and re-running auto-detection would silently
drop it again.

This matters for the pitch: "run what you can't run locally" is easy to
demo once you've manually wired up the backing service, but there is not yet
a first-class, durable way to declare "this project also needs Postgres/
Redis/etc." as part of `chunk init` / `chunk sidecar setup`. Positioning this
honestly: the *sidecar* (a full Linux cloud environment with sudo) can
clearly host any backing service you can `apt install` or run in Docker — the
gap is in **repeatable environment declaration**, not in what the sidecar can
physically do.

## Setup (condensed from calculator-app's DEMO.md)

```bash
# One-time: provision Postgres on the sidecar (manual today — see gap above)
chunk sidecar exec --command sh -- -c \
  "sudo apt-get update -qq && sudo apt-get install -y postgresql && sudo service postgresql start && sudo -u postgres psql -c \"CREATE USER calc WITH PASSWORD 'calc';\" && sudo -u postgres psql -c \"CREATE DATABASE calculator OWNER calc;\""

# Then: sync + run migrate + the integration test gate
chunk validate --remote
```

## Repeatability

`calculator-app`'s `bench.sh` (on the `luisejroblescci-demo/local-workload-offload`
branch) reruns `chunk validate --remote` N times and writes pass/fail +
duration to `results/<timestamp>.json`. It assumes Postgres is already
provisioned on the active sidecar (the manual step above) — it does not
reprovision from scratch, since that's exactly the durable-setup gap noted
above.
