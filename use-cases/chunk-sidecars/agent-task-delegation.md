# Use case: delegate the grunt work to an agent

**Source:** `chunk.ai value props and use cases` doc, value prop 3.

**Persona:** developer.

**The pain:** *"I just need the agent to fix the merge conflicts without
spinning a whole session for it."* Mechanical tasks (merge conflicts, adding
test coverage, dependency upgrades, style-guide migrations) are quick but
still cost environment setup, context management, and babysitting if done in
a full local agent session.

**What Chunk does about it:** `chunk sidecar exec` runs any CLI-invokable
coding agent one-shot in a clean cloud environment. The agent does the work,
you move on — no chat UI, no local setup, no context switching.

**Benefit to the user:** a single command replaces a full interactive agent
session for tasks that don't need one.

## Feasibility verdict: **Mechanism validated; full agent-in-the-loop not validated**

Demonstrated on
[`calculator-app`](https://github.com/luisejroblesci/calculator-app/tree/luisejroblescci-demo/agent-task-delegation)
— see that branch's `DEMO.md` for the full walkthrough and `AGENT.md` for
agent-replayable instructions.

**What's solid:** `chunk sidecar exec` reliably runs an arbitrary one-shot
command against a clean, already-synced sidecar, and the result can be
pulled back with `chunk sidecar exec --command cat --args <path>`. A real
mechanical refactor (extracting a magic number into a named constant) was
performed this way and produced a correct, inspectable diff in well under a
second per run (0.6–0.7s), on top of an already-warm sidecar.

**What's not validated:** an actual AI coding agent (e.g. `claude -p "..."`)
reading a natural-language instruction and producing that refactor
unattended. The demo used a small deterministic Node script
(`refactor-task.js`) as a stand-in, specifically because running a real
agent CLI on the sidecar requires forwarding a real provider credential
(`ANTHROPIC_API_KEY` or an OAuth token) to CircleCI-hosted cloud
infrastructure — and this validation pass intentionally did not push any
real account credentials off-machine just to produce a demo artifact.

This is a meaningful distinction for the pitch: the *plumbing* (one-shot
remote exec, result pull-back) is proven fast and reliable. Whether a real
agent, given credentials, reliably turns a prompt into a correct refactor is
a property of the agent/model, not of Chunk — but it's the part of this
value prop that a live, credentialed demo still needs to show.

## A secondary finding

`chunk sidecar ssh -- cat <path>` — the exact form shown in
`chunk-cli/docs/GETTING_STARTED.md`'s lock-file regeneration example — failed
with `invalid argument` in this run. `chunk sidecar exec --command cat
--args <path>` worked reliably and was used instead. Worth a docs fix or a
CLI fix, whichever side is actually broken.

## Setup (condensed from calculator-app's DEMO.md)

```bash
chunk sidecar sync
chunk sidecar exec --command sh -- -c "cd /home/user/calculator-app && node refactor-task.js"
chunk sidecar exec --command cat --args /home/user/calculator-app/script.js > script.js
```

For a real agent-in-the-loop run (not attempted here — see above):

```bash
chunk sidecar exec --command claude --args '-p "refactor script.js to extract the magic number 15 into a MAX_DIGITS constant"'
```
(requires the agent CLI installed on the sidecar and a credential forwarded via `-e`/`.env.local`.)

## Repeatability

`calculator-app`'s `bench.sh` (on the `luisejroblescci-demo/agent-task-delegation`
branch) reruns the one-shot task N times — it's idempotent (no-ops if the
refactor is already applied) — and records wall-clock time to
`results/<timestamp>.json`.
