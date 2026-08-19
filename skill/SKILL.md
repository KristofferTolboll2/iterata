---
name: iterata
description: Run the design iteration loop for this project. Default mode is micro-iterations, one small visible change at a time, verified in seconds with a quick Playwright shot against the dev server and shown to the owner immediately. The heavy machinery (full screenshot rig, design review, adversarial evaluation, version tag, gallery) runs only at checkpoints. Use when asked to iterate on the design, run the design lab, or produce new design versions.
---

# Design iteration pipeline

Two speeds. Micro-iterations are the default; checkpoints bundle them into
reviewed, tagged versions. Everything happens on the `design-lab` branch.
Never run this on the default branch.

## Micro-iteration (the default, minutes not tens of minutes)

Hard rules for pace: NO subagents, the main session edits directly. ONE
focused visible change per iteration (a section, a showpiece, a spacing
pass). If a change needs more than about five minutes of work, split it.

1. Ensure the dev server is running in the background. Start it once, keep it
   alive across iterations.
2. Make the change.
3. `iterata <label> --quick` : one dark desktop full-page shot against
   the dev server in seconds, saved to `design-lab/quick/<label>.jpg`. Look
   at it.
4. Show the owner the shot path and one or two sentences on what changed.
   Their reaction IS the feedback loop at this speed; do not spawn review
   agents between micro-iterations.
5. Repeat on their direction.

**A still frame cannot review an animation.** When the change is motion, say
so and ask the owner to watch it, or capture a filmstrip by hand. Do not
report an animation as working on the strength of one screenshot. This is the
loop's largest known blind spot.

## Checkpoint (on request, or after a coherent batch of micro-iterations)

1. The project's build and lint commands must pass.
2. Commit on `design-lab`, tag the next `design/vX.Y`
   (`git tag -l 'design/v*' | sort -V | tail -1` for the current one).
3. Full rig: `iterata v<X.Y>` (builds, serves, captures the set).
4. OPTIONAL review pass, only when the owner asks for one or the design has
   drifted without outside eyes: ONE subagent running a design critique
   (findings.md, max 8 findings, scoped to the diff since the last reviewed
   version) and ONE running an adversarial evaluation (verdict.md:
   apply / reject / hold per finding). Cap each agent's job at review, never
   implementation. Both depend on skills installed at the user level; if they
   are absent, say so and skip the pass rather than improvising a substitute.
5. Update `design-lab/LOG.md` and the gallery.

## Versioning

- `design/vX.Y` tags on `design-lab`; minor bump per checkpoint, cumulative.
- When the owner picks a winner: merge to the default branch and tag the next
  major-cycle number (first accepted design is `design/v1.0`, later rounds
  `v1.1`, `v1.2`).

## Guardrails, always

- **The consuming project's `CLAUDE.md` wins, verbatim.** Read it before the
  first iteration and treat its hard rules as non-negotiable. This skill adds
  process, never permission.
- Copy is not the pipeline's to change. New or reworded user-facing strings
  are proposals: mark them `// COPY PROPOSAL` where the project keeps its
  copy, keep a running list, and never present copy as final.
- Respect the project's stated motion policy and library split. Every
  animation honors `prefers-reduced-motion` and falls straight to its final
  state.
- Section order and information architecture are fixed unless the owner opens
  them. Within-section restructure is fair game.

## Gallery

`design-lab/gallery.html`, published for the owner. Per version: downscaled
screenshots (desktop dark, mobile dark, light), what changed, and the open
copy-proposal list. Newest last.

## Picking a winner

When the owner names a version: merge that tag to the default branch, tag the
next major-cycle number, note it in `LOG.md`. Copy proposals are applied only
when the owner approves them, as a separate commit.
