<p align="center">
  <img src="https://raw.githubusercontent.com/KristofferTolboll2/iterata/main/assets/iterata.jpg" width="900"
       alt="iterata: six Mona Lisas in a row, progressing from a rough pencil sketch on torn paper, through a gridded line drawing, a flat colour block-in, a loose underpainting and a finished panel, to the framed masterpiece.">
</p>

<p align="center"><em>A two-speed design iteration loop for Claude Code.</em></p>

Most agent-driven design loops fail the same way: they are too slow to stay in
a conversation. You ask for a change, the agent spawns reviewers, runs a build,
captures a gallery, and comes back twenty five minutes later with a version you
did not want. By then you have lost the thread.

This tool splits the loop in two.

**Micro-iteration** is the default and runs in seconds. One change, one
screenshot against the already-running dev server, shown to you immediately.
Your reaction is the feedback loop. No subagents, no build, no ceremony.

**Checkpoint** runs on request. It builds, serves, captures the full set across
viewports and themes, optionally runs a design critique and an adversarial pass
over that critique, and tags a version you can revert to.

## Install

```bash
npm install
npx playwright install chromium
```

Then, in the project you are designing, copy `config.example.json` to
`iterata.config.json` and set `themes`, `hideOnFullPage` and `sections`. Every
field has a default, so the tool also runs with no config against a plain
Next.js app.

`themes` is the one worth getting right first. It defaults to
`["dark", "light"]`; a site with a single theme should list only that theme,
or the rig captures the same page twice under two different names.

`routes` defaults to `["/"]`. A project with more than one page worth
reviewing lists them all, and the full rig captures every route crossed with
every theme.

Install the skill by copying `skill/SKILL.md` to
`.claude/skills/iterata/SKILL.md` in the consuming project.

[SETUP.md](SETUP.md) walks the whole thing end to end: which config fields are
worth deciding rather than defaulting, how to tell a good first run from a
broken one, and how the loop is meant to be worked day to day. Hand it to
Claude and let it do the setup.

## Use

```bash
# Micro-iteration: one shot against a running dev server, seconds.
iterata hero-spacing --quick

# A route other than the first configured one
iterata hero-spacing --quick --route /da

# Against something other than localhost:3000
iterata hero-spacing --quick --url http://localhost:5173

# Checkpoint: build, serve, capture the whole set. The version is optional,
# and comes from the ledger when omitted.
iterata --note "tightened the section rhythm"

# Or name it, when a round is accepted
iterata v1.0 --note "accepted"

# Checkpoint without rebuilding
iterata --skip-build

# What has been captured here before
iterata --list

# Build <outDir>/gallery.html from the ledger
iterata --gallery

# Before/after report for two versions
iterata --diff v0.1 v0.2

# Capture without spending a version number
iterata freeze-check --scratch

# Measure motion instead of photographing it
iterata --probe --selectors ".hero,.statue" --at 0,400,900,2400
```

Output lands in `design-lab/quick/<label>.jpg` or
`design-lab/<version>/screens/*.jpg`.

## Reviewing motion

Every capture in this tool is a still, and a still cannot review an animation.
It is worse than unhelpful: a shot fired mid-sequence catches one arbitrary
frame and presents it as the design.

`--probe` measures instead of photographing.

```
$ iterata --probe --selectors ".enter" --at 0,150,400,900
time    selector  opacity  transform
0ms     .enter    0        matrix(1, 0, 0, 1, 0, 40)
151ms   .enter    0        matrix(1, 0, 0, 1, 0, 40)
400ms   .enter    0.453384 matrix(1, 0, 0, 1, 0, 21.8646)
901ms   .enter    1        matrix(1, 0, 0, 1, 0, 0)
```

It reads computed style from the DOM, so it is the one mode unaffected by which
frame anything is on, and "lands at opacity 1 by 900ms" becomes checkable. It
does not run `freezeMotion` or settle the page, because the clock starting at
navigation is the thing being measured. A selector matching nothing is reported
rather than silently omitted.

It cannot tell you whether the motion looks good. It can tell you it runs and
where it ends.

The default properties are `opacity`, `transform`, `visibility` and `display`,
which are blind to SVG geometry. A draw animates `stroke-dashoffset`, a carve
animates `y`, a morph animates `d`, and under the defaults all three report as
perfectly static. Because showpiece work is overwhelmingly SVG, that is the
default question being blind on the category most worth reviewing, so when a
selector matched and nothing moved, the probe says so rather than letting the
table read as a result:

```
warning: no sampled property changed for [data-wipe].
  That is not the same as "does not animate": the motion may be driving a
  property you did not request. SVG geometry is the usual culprit, so try
  --props stroke-dashoffset,y,x,width,height,d,r,cx,cy
```

## Comparing versions

`iterata --diff <a> <b>` writes a report showing what actually changed between
two captured versions: every shot they share, the count of differing pixels,
and each changed region cropped from both versions and shown side by side.

The comparison is per-pixel with a low threshold, and that is a deliberate
choice rather than an implementation detail. A row mean or an image mean will
report "nothing changed" when something did, because two glyphs appearing on a
6040px page cannot move an average. A diff that misses a change reports clean,
and nothing prompts you to look again. Two versions of a real site differed by
0.004% of their pixels; that is invisible to someone flipping between two tall
screenshots, and obvious in the report.

It runs against captured versions only, so it needs no server, build or
network, and it decodes in the Chromium that Playwright already provides rather
than adding an image library.

## Versioning

Versions are iterata's own, held in `<outDir>/manifest.json` beside the
captures. A checkpoint with no version takes the next number, `--note` records
what changed, and `iterata --list` reads the history back. There is no log file
to keep by hand.

No version control is required at any point. When the project happens to be a
git repository the commit is recorded against each version, because the useful
thing a version number points at is the code that produced it — but that is a
recording, not a dependency, and iterata behaves identically without it.

## What the full rig captures

`<primary>` is the first entry in `themes`. With the default
`["dark", "light"]` that is `dark`, and the last row expands to
`desktop-light-full`.

Every row is captured once per configured route. Non-root routes prefix their
slug (`da-desktop-dark-full.jpg`); the root route does not, so a single-route
project sees the names below unchanged.

| Shot | Why |
|---|---|
| `desktop-<primary>-full` | Whole-page composition and rhythm |
| `desktop-<primary>-hero` | First viewport, with fixed chrome left in |
| `desktop-<primary>-<section>` | One crop per configured section id |
| `mobile-<primary>-full` | Narrow-viewport layout |
| `mobile-<primary>-<section>` | The same crops where a layout breaks first |
| `desktop-<primary>-reduced-motion` | Content must land in its final state |
| `mobile-<primary>-reduced-motion` | The same, where reveals often differ |
| `desktop-<theme>-full` | One per remaining theme, none on a single-theme site |

Fixed elements are hidden during full-page captures, because a
`position: fixed` header repeats down the image otherwise. Theme is seeded
into `localStorage` before load so shots are deterministic rather than
depending on the OS setting.

## Status

Version 0.1.0, extracted from the project it was built for. It has real
mileage (seven tagged design versions on a production site) and real gaps.

The largest gap by a distance: a screenshot cannot review an animation, and
this tool captures screenshots. Motion defects, and anything that only
reproduces on a real device rather than an emulated viewport, still need a
human watching.

[REPORT.md](REPORT.md) is the full handover: what earned its keep, the ten
pain points ranked by what they cost, and the seven missing pieces in the
order they are worth building. Read it before building on this.

## License

MIT.
