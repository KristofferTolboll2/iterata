---
name: iterata
description: Run the design iteration loop for this project. Default mode is micro-iterations, one small visible change at a time, verified in seconds with a quick Playwright shot against the dev server and shown to the owner immediately. The heavy machinery (full screenshot rig, design review, adversarial evaluation, versioned checkpoint, gallery) runs only at checkpoints. Use when asked to iterate on the design, run the design loop, or produce new design versions.
---

# Design iteration pipeline

Two speeds. Micro-iterations are the default; checkpoints bundle them into
reviewed, numbered versions.

Versions are iterata's own: `iterata` with no version reads the ledger at
`<outDir>/manifest.json`, takes the next number, and records the run. Nothing
here needs a VCS. If the project happens to use one, iterata notes the commit
against each version and the guidance below on branching applies; if it does
not, skip those lines and the loop works identically.

## First run in a project

Before iterating, confirm the loop actually works here. Once, not every time.
`SETUP.md` in the iterata repo is the long form; this is the checklist:

1. `iterata` must resolve as a command. If it does not, install it
   (`npm i -D github:KristofferTolboll2/iterata`) and add a `shots` script.
2. `iterata.config.json` must exist at the project root. Copy
   `config.example.json` and set at minimum: `themes` (list only the themes
   the site actually has, or the rig shoots one page twice under two names),
   `routes` (every page worth reviewing, not just the root), `hideOnFullPage`,
   `sections`, and `themeStorageKey` (null if there is no theme switcher).
   Read these off the code rather than assuming them.
3. Run the full rig once and read the warnings. A `hideOnFullPage matched
   nothing` or `section #x not found` warning means the config is describing
   markup that no longer exists: fix it now, not after a batch of iterations
   has been captured against it.
4. `iterata --list` shows what has been captured here before. If the project
   has been iterated on outside this pipeline, say so and agree a starting
   point with the owner rather than letting the ledger start at v0.1 as
   though nothing existed.

## Micro-iteration (the default, minutes not tens of minutes)

Hard rules for pace: NO subagents, the main session edits directly. ONE
focused visible change per iteration (a section, a showpiece, a spacing
pass). If a change needs more than about five minutes of work, split it.

1. Ensure the dev server is running in the background. Start it once, keep it
   alive across iterations. If a shot does not show the change you just made,
   suspect the server before you suspect the change: restart it and reshoot
   rather than editing again on top of a stale frame.
2. Make the change.
3. `iterata <label> --quick` : one desktop full-page shot in the project's
   primary theme, against the dev server, in seconds, saved to
   `design-lab/quick/<label>.jpg`. Look at it.
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
2. Full rig: `iterata --note "<what changed>"`. It takes the next version
   number itself, captures the set, and writes the run to the ledger. Pass an
   explicit version only when the owner names one.
3. If the project uses version control, commit the source change now and say
   which version it produced. Work on a branch rather than the default one, so
   an exploration that goes nowhere costs nothing. iterata records the commit
   against the version either way.
4. OPTIONAL review pass, only when the owner asks for one or the design has
   drifted without outside eyes: ONE subagent running a design critique
   (findings.md, max 8 findings, scoped to the diff since the last reviewed
   version) and ONE running an adversarial evaluation (verdict.md:
   apply / reject / hold per finding). Cap each agent's job at review, never
   implementation. Both depend on skills installed at the user level; if they
   are absent, say so and skip the pass rather than improvising a substitute.
5. `iterata --diff <previous> <this>` writes the before/after report and is
   what you show the owner. Do not describe a checkpoint as "no visible change"
   on the strength of looking at two full-page shots: real changes routinely
   come to a few thousandths of a percent of the pixels, and a side effect you
   did not intend, an element nudged by a sibling's layout, looks like nothing
   until the diff puts the two crops next to each other.
6. `iterata --gallery` rebuilds `<outDir>/gallery.html` from the ledger. There
   is nothing to maintain by hand: `--note` put the description in the ledger,
   `iterata --list` reads it back, and the gallery is generated from the same
   record. Never hand-write that file, or two runs of this loop produce
   differently shaped projects.

## Versioning

- `vX.Y`, minor bump per checkpoint, held in `<outDir>/manifest.json`.
- When the owner picks a winner, the next version is theirs to name: the first
  accepted design is `v1.0`, later rounds `v1.1`, `v1.2`. Pass it explicitly
  (`iterata v1.0`) since only the owner knows a round has been accepted.
- Never renumber or delete past versions to tidy the ledger. A version that
  was shown to someone is a thing they remember by number.

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

`iterata --gallery` writes `<outDir>/gallery.html` from the ledger: every
version, its note, its commit where there was one, and the shots that version
actually produced. Branch is shown per version, because a ledger spanning
branches otherwise interleaves them under one ascending list of numbers.

Publish that file for the owner. Keep the open copy-proposal list alongside it
in your message rather than in the file, since the ledger does not track copy.

## Picking a winner

When the owner names a version, capture the next major-cycle number against it
(`iterata v1.0 --note "accepted"`) so the ledger records the decision. If the
project uses version control, that is also when the winning branch merges.
Copy proposals are applied only when the owner approves them, separately.
