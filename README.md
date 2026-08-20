<p align="center">
  <img src="https://raw.githubusercontent.com/KristofferTolboll2/iterata/main/assets/iterata.jpg" width="900"
       alt="Screenshots of a page across several design versions">
</p>

# iterata

A design iteration skill for Claude Code. It interviews you about what you
want, writes a brief from your answers, then generates and refines versions
against it, bringing you a considered round rather than every intermediate
step.

There is no CLI, no config file and nothing to install. It is one file.

## Install

Copy the skill into the project you are designing:

```bash
mkdir -p .claude/skills/iterata
curl -o .claude/skills/iterata/SKILL.md \
  https://raw.githubusercontent.com/KristofferTolboll2/iterata/main/skill/SKILL.md
```

The project needs Playwright available for screenshots. Most already have it;
if not, `npm i -D playwright && npx playwright install chromium`.

Then ask Claude to iterate on the design.

## What it does

**Interviews you first.** Six questions plus free text: who it is for, what
world it lives in, what is fixed, what is open, how much motion, and what would
make you reject a version. That last one does most of the work.

**Writes a brief you confirm.** Including a rejection list, phrased as
statements that can actually be checked. A wrong brief is cheap to fix before
three versions exist and expensive after.

**Iterates alone, then shows you a round.** It critiques its own output against
the brief and fixes what it finds, so the rounds you spend attention on are the
ones worth your attention.

**Audits what a pivot left behind.** When the visual world changes, the
previous world's motion, disclosure widgets and column structure survive it
silently, because nothing breaks. Components keep working perfectly in a world
they no longer suit. The skill treats those as one question rather than three.

## What it knows about capture

The skill carries the things that are easy to get wrong and hard to notice:

- Re-read the page height while scrolling, or a lazily growing page has its
  tail never visited and its reveals never fired.
- Hide `position: fixed` chrome before a full-page shot or a crop, or a dock
  composites into the frame and reads as a fault in the design.
- Compare versions per pixel, never by an average. Two glyphs on a long page
  cannot move a mean, so a mean reports "nothing changed" with total
  confidence.
- Freeze looping animations before comparing, and know that this reaches CSS
  and Web Animations only: a `requestAnimationFrame` loop cannot be frozen this
  way.
- A still cannot review an animation. It catches one arbitrary frame and
  presents it as the design. Measure the DOM over time instead, and remember
  that `opacity` and `transform` are blind to SVG geometry.

## History

[REPORT.md](REPORT.md) is the handover from when iterata was a CLI, kept as a
record of what the screenshot rig got right and where it went wrong. The
reasoning outlived the code.

## Licence

MIT.
