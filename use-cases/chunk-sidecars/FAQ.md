# Chunk sidecar FAQ

Answers grounded in `chunk-cli/docs/CLI.md` and `docs/GETTING_STARTED.md`,
plus what we hit hands-on validating the three use cases in this folder.
Where the honest answer is "we don't know yet," it says so — don't
improvise an answer live.

**What is a sidecar, in one sentence?**
An ephemeral Linux environment running on CircleCI's infrastructure that you
sync your code to and run checks (or anything else) on, instead of running
them locally.

**Is it available on free CircleCI plans?**
Yes — per `chunk-cli/docs/GETTING_STARTED.md`, sidecars are available to all
CircleCI customers, including free plans.

**What happens to secrets when I sync to a sidecar?**
`chunk sidecar sync` sends your working tree via git bundle (or checkout/
patch with `--checkout`) — it does not read `.env.local`. Secrets are
forwarded separately: `chunk sidecar ssh`, `chunk sidecar setup`, and
`chunk validate --remote` automatically load `.env.local` (gitignored by
convention) and forward its variables to the sidecar session, or you can
pass them explicitly with `-e KEY=VALUE`. Nothing in `.env.local` is ever
committed by convention.

**What if my agent/workload needs a GPU?**
Not evaluated in this round of demos. `chunk sidecar create --image <id>`
takes an E2B template ID or container image, so a GPU-backed image is
plausible, but we have not tested it. Answer honestly as "not yet validated"
rather than promising it.

**How is this different from GitHub Codespaces / devcontainers / running
Docker Compose locally?**
No data yet — this is exactly the competitor-benchmarking gap called out in
[README.md](README.md). Don't claim a specific advantage over these until
that benchmark exists. What we can say today: a sidecar needs no local
container runtime at all (our use-case-2 demo ran successfully on a machine
with no Docker daemon running), which a local Docker Compose workflow can't
match by definition — but we haven't measured it against Codespaces.

**What's the cold-start time for a fresh sidecar vs. a snapshotted one?**
Not directly measured in this round (all three demos reused an existing,
already-provisioned sidecar). `chunk sidecar snapshot create --name
<name>` captures a configured environment so future sidecars boot faster
from `chunk sidecar create --image <snapshot-id>` — but we don't have a
before/after number yet. Flag as a good follow-up benchmark.

**Can multiple developers share one sidecar?**
Not evaluated. Sidecars are scoped per active-sidecar state on the local
machine (`$XDG_DATA_HOME/chunk/<project>/`), and nothing in the docs
suggests a real-time multi-writer model — `chunk sidecar sync` overwrites the
remote tree from one local working copy at a time. Treat as single-developer
per sidecar until tested otherwise.

**How do I control sidecar cost/usage?**
We don't know — there's no pricing/billing model for sidecars yet (see
[README.md](README.md)). Don't answer this live; say it's coming.

**Can a custom backing service (Postgres, Redis, etc.) survive if I rerun
`chunk sidecar setup`?**
No, not today. We hit this directly: `chunk sidecar setup --force` /
`chunk sidecar env` regenerate `environment.setup` from auto-detection and
will drop a manually added step. See [local-workload-offload.md](local-workload-offload.md#the-real-gap-this-surfaced)
for the exact failure and workaround.

**Does `chunk validate --remote` require a TTY / interactive session?**
No — that's specifically why our benchmark tooling and demos use
`chunk sidecar exec` for scripted gate commands: it avoids the TTY
requirement that `chunk validate --remote` can have in some contexts. Both
work for a human at a terminal; prefer `sidecar exec` for automation.

**Is `chunk sidecar exec` safe to use for pulling files back from the
sidecar, not just running commands?**
Yes, and it's the more reliable path today: `chunk sidecar exec --command
cat --args <path>` worked reliably in our testing, while `chunk sidecar ssh
-- cat <path>` (the form shown in the lock-file-regeneration example in
`chunk-cli/docs/GETTING_STARTED.md`) failed with `invalid argument` in our
run. Worth a doc or CLI fix — see [agent-task-delegation.md](agent-task-delegation.md).
