# State of the tool

Written 19-08-2026, at the point the pipeline was extracted from the site it
was built for. It ran that site from a blank template to a deployed, tagged
v1.1 over one working session.

## Verdict in one paragraph

The lightweight half of this tool is genuinely good and should be the thing
that gets built on. The heavy half, the part that was designed first and most
carefully, was used twice and then quietly abandoned. The single biggest
limitation is not a bug: it is that the tool reviews design by taking
screenshots, and the site it was built for is mostly animation. Every motion
defect and every mobile defect over seven versions was found by a human
looking at a screen, never by the rig. That is the gap worth closing.

## How it works today

**Micro-iteration.** Dev server stays up. Make one change, run
`iterata <label> --quick`, get one dark desktop full-page JPEG in a few
seconds, look at it, show the owner. No subagents, no build. The owner's
reaction is the review.

**Checkpoint.** Build, serve on a private port, capture eight shots across
desktop dark, desktop light, mobile dark, section crops and a reduced-motion
pass. Commit on `design-lab`, tag `design/vX.Y`, update a log and a gallery.
Optionally spawn one critique agent and one adversarial agent over its
findings.

**Versioning.** `design/vX.Y` tags accumulate on a `design-lab` branch. The
owner names a winner, that tag merges to the default branch and gets the next
major-cycle number.

## What actually happened

| Path | Times used |
|---|---|
| Quick shots (micro-iteration) | 126 |
| Full rig (checkpoints) | 7 |
| Critique + adversarial review pass | 2 |

The design was originally specced as three subagents per iteration, three
iterations per run, with a token budget of 350k to 450k per run. The first
run took over twenty five minutes and the owner stopped it mid-flight:

> "It's taking way too long over 25 minutes? let's stop here, and rethink the
> tool the iterations should be much shorter maximum a few minutes small
> iterations before going into the feedback loop"

Everything good about the tool dates from that correction. The 126-to-2 ratio
is the honest summary of which half earned its keep.

## What works

**The quick path is the right primitive.** Seconds from edit to image is fast
enough to stay inside a conversation, which is the only speed at which design
review actually works. Skipping the build and reusing a warm dev server is
most of why.

**Version tags earned their keep.** Used exactly once, when an iteration made
a transition worse and the owner said "please revert back to the previous
version and try again". Recovery was `git show <tag>:<path>` and took
seconds. Without the tags that iteration would have been reconstructed from
memory.

**Deterministic theming.** Seeding `localStorage` before load, rather than
relying on `prefers-color-scheme`, is what makes light and dark shots
reproducible. Worth keeping in any rewrite.

**Hiding fixed elements before full-page capture.** Small detail, large
effect: without it a fixed dock repeats down the entire image and the
screenshot is unreadable. This is the kind of thing you only learn by
shipping.

**Two named speeds.** Having an explicit cheap mode and an explicit expensive
mode, rather than one mode with flags, is what stopped the loop from drifting
back toward ceremony.

## Pain points

Ranked by how much they cost over the seven versions.

**1. A screenshot cannot review an animation.** The two showpieces on that
site were a per-glyph name reveal and a hand-drawn signature. Both are motion.
Every defect in them was caught by the owner watching, never by the rig: a
mono digit standing in as a letter stem at the wrong scale, a gradient whose
oklch interpolation travelled through olive, a frame in the middle of a
handoff that broke the illusion, signature pacing that needed to accelerate
before it failed. A still frame either misses these or, worse, shows a frame
that looks fine. This is the defining limitation of the tool as it stands.

**2. An emulated 390px viewport is not a phone.** The rig captured mobile dark
at every one of seven checkpoints and flagged none of the four real mobile
bugs: a theme toggle rendering at 40px inside a 20px box, that toggle staying
magnified after a tap because touch fires `mousemove` and never `mouseleave`,
digits colliding in the fallback font during a slow font load, and a 5.9
second LCP. All four were found by the owner on his own phone. Viewport size
is the least interesting thing that differs between a desktop Chromium and a
real device.

**3. `settle()` is fixed-timing guesswork.** It scrolls in 500px steps with a
250ms pause, waits a flat two seconds, scrolls back and waits 600ms more. It
has no idea whether animations have finished. Slower than necessary on static
pages, and captures mid-flight on anything longer than two seconds. It also
still calls a load-state wait that means nothing on a page with a canvas that
never stops painting.

**4. No visual diff.** Comparing two versions means opening two JPEGs and
eyeballing them. Nothing surfaces "this moved four pixels". Pixel diffing is
additionally blocked by design: the site has an always-animating canvas
backdrop, so every capture differs from every other capture regardless of what
changed. Any diff implementation needs region masking first.

**5. Performance is invisible to the loop.** LCP sat at 5.9 seconds through
several checkpoints and nothing noticed. It was found later by a separate
audit, and the cause was a design decision the rig had photographed happily
seven times: the hero image started clipped in CSS and could not paint until
JS hydrated. A design tool that captures the hero and never times it will keep
missing this class of problem.

**6. The review pass is too expensive to use.** One critique agent plus one
adversarial agent per checkpoint was the original centrepiece. It ran twice.
At conversational speed the owner is a better and faster reviewer than two
subagents, and by the time the agents report, the design has moved on.

**7. Screenshots are not preserved.** `design-lab/` is gitignored, so the
tagged versions exist but the images of them do not. The visual history is
whatever is still on that laptop.

**8. The gallery is hand-built.** An HTML page assembled by the agent each
checkpoint and republished. Expensive enough per checkpoint that it drifted
out of date, which is exactly what you would predict of a manual step inside
an automated loop.

**9. The reduced-motion shot is captured and never checked.** Nothing asserts
that content landed in its final state. A human compares it against the normal
shot, or does not.

**10. State lives in the consuming repo.** Version tags, the `design-lab`
branch and the output directory all belong to the project being designed.
That means the tool cannot run against a non-git project, and it leaves seven
`design/*` tags in a site repo that has nothing else to do with them.

## Missing parts

In the order I would build them.

1. **Filmstrip capture.** N frames across an animation's duration, tiled into
   one image, or a short video or GIF. This closes the largest gap and is not
   hard: Playwright records video per context already. Until this exists the
   tool's own skill tells the agent to stop and ask a human whenever the
   change is motion, which is honest but is not a feature.
2. **Throttled capture.** CPU and network throttling through CDP, so slow
   font loads and late-hydration layout shifts show up in the image. Cheap to
   add, and would have caught two of the four mobile bugs above.
3. **Core Web Vitals per shot.** LCP, CLS and TTFB recorded alongside each
   capture and written to a JSON sidecar, so a regression is a number in the
   log rather than a discovery three weeks later.
4. **Masked visual diff.** Region masks for canvases and other perpetually
   moving elements, then a real diff with a threshold. Without masks this is
   not possible on any site with ambient motion.
5. **Assertions, not just images.** Horizontal overflow, contrast on the
   primary text pairs, reduced-motion final state, images without intrinsic
   dimensions. All checkable in the same browser session that is already open.
6. **A generated gallery.** Static HTML built from the output directory and
   the log, so the checkpoint step has no manual authoring in it.
7. **Capture against a deployed URL.** The quick path already accepts
   `--url`; the full rig does not, so there is no way to shoot production and
   compare it against local.

Below those: tests for the script itself (it currently has none), and a real
install path for the skill rather than copying a Markdown file by hand.

## Notes on the extraction

The repo has a **fresh git history**. It was not filtered out of the site
repo, deliberately: those commits contain names that are not allowed to be
public, so nothing from that history can travel with the tool.

Changed in the move, all behaviour-preserving:

- Hardcoded selectors and section ids moved into `iterata.config.json`.
  Previously the dock was found with a literal Tailwind class selector
  (`div.fixed.bottom-4`) and sections were a literal array in the source.
- A selector that matches nothing now prints a warning. Before, a markup
  change would silently produce full-page captures with the fixed chrome
  repeated down them and no indication anything was wrong.
- A missing section id warns and skips instead of throwing.
- The skill lost the consuming project's specific hard rules, which named
  clients and employers. It now defers to whatever `CLAUDE.md` the consuming
  project has, which is the correct relationship anyway.
- The skill gained an explicit instruction not to report an animation as
  working on the strength of one screenshot.

Still coupled and worth deciding on: the defaults assume Next.js
(`next build`, `next start`), and the skill still assumes a `design-lab`
branch and `design/vX.Y` tags in the consuming repo.

The original copy in the site repo was left in place and still works, so the
design workflow there is not broken by this extraction. Cutting that repo over
to consume this one is a separate, one-line decision.
