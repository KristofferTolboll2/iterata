---
name: iterata
description: Design a web page or interface by interviewing the owner about what they want, then generating and refining versions against their answers. Opens with a short design interview, turns the answers into a brief, works through several versions critiquing its own output, and brings the owner a considered round rather than every intermediate step. Use when asked to design, redesign, iterate on, or improve the look of a site or interface.
---

# Design iteration

Three phases. Ask, then work, then show. The owner is interviewed once at the
start, left alone while you iterate, and brought a finished round rather than a
running commentary.

There is nothing to install and nothing to configure. Everything below you do
directly, in the project you are already in.

## 1. Interview

Never start designing from a one-line request. Ask first, in one message, short
enough to answer in a sitting. Six questions:

1. **Who is this for, and what should they do or feel?** One or two sentences.
2. **What world does it live in?** Ask for reference points rather than
   adjectives: sites they like, a physical object, a material. "A printed
   sheet" tells you more than "clean and modern".
3. **What is fixed?** Section order, copy, brand colours, logo: anything
   already decided that you must not touch.
4. **What is open?** The parts they actively want changed.
5. **How much motion?** From none, through entrance reveals, to showpieces. Ask
   explicitly, because motion is the thing most often inherited by accident.
6. **What would make you reject a version?** The most useful question in the
   set. It surfaces constraints people never think to state.

Then: **"Anything else, in your own words?"** Free text catches what the
questions did not.

If the project has a `CLAUDE.md`, `DESIGN.md` or similar, read it before asking
and ask only about what it does not cover. Do not make them repeat themselves.
Treat any hard rule there as binding, and if the file contradicts what you see
in the code, say so and ask which is current: a stale design document will
steer the whole round wrong.

## 2. Write the brief

Turn the answers into a short brief, in the project, before designing. Ten to
fifteen lines. It exists so you can check your own work against something
stated rather than against your memory of a conversation.

It must contain a **rejection list**: the specific things that would make a
version wrong, from question 6 and from anything fixed in question 3. That list
is what you test against later, so write checkable statements, not sentiments.
"Nothing important is hidden behind a click" can be checked. "Feels premium"
cannot.

Show the brief and get it confirmed before building anything. A wrong brief is
cheap to fix now and expensive after three versions.

## 3. Iterate

Work in versions. A version is a coherent attempt, not a single edit.

For each: build it, look at it, critique it against the brief yourself, fix
what you find. Only then start the next. Keep going until you would be content
to defend the result, then bring it to the owner.

**Look at your own work before showing it.** Take a screenshot and actually
read it. Most of what an owner would tell you is visible in the capture, and
the point of iterating alone is to spend those rounds yourself instead of
spending their attention on them.

Do not narrate every version. They asked for a design, not a commentary.

### Seeing what you built

Use Playwright directly against the dev server. Do not build a tool for this.

```js
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:3000", { waitUntil: "load" });

// Scroll in steps so scroll-triggered reveals fire, re-reading the height each
// time: a page that grows lazily is taller at the bottom than it was at the
// top, and a height sampled once leaves the tail unvisited and unrevealed.
await p.evaluate(async () => {
  const h = () => Math.max(document.body.scrollHeight,
                           document.documentElement.scrollHeight);
  for (let y = 0, n = 0; y < h() - innerHeight && n < 200; n++) {
    scrollTo(0, (y += 500));
    await new Promise((r) => setTimeout(r, 250));
  }
});
await p.waitForTimeout(2000);            // let entrance animations finish
await p.evaluate(() => scrollTo(0, 0));

// position:fixed chrome repeats down a full-page capture and composites into
// the middle of a crop. Hide it for the shot.
await p.evaluate(() => document.querySelectorAll("header.fixed, [data-dock]")
  .forEach((e) => (e.style.display = "none")));
await p.screenshot({ path: "shot.jpg", type: "jpeg", quality: 80, fullPage: true });
await b.close();
```

Then read the image. Shoot the narrow viewport too: a layout breaks there
first, and a section that is fine at 1440px is often broken at 390px.

To study one section, crop to the element rather than squinting at a tall
page — and hide the fixed chrome for that shot too, or a dock composites into
the middle of the crop and reads as a fault in the section.

### Reviewing motion

**A still cannot review an animation, and it fails in the worst way.** A shot
fired mid-sequence catches one arbitrary frame and presents it as the design. A
wordmark that morphs through three faces before landing photographs as a face
no visitor ever sees.

When the change is motion, measure instead of photographing. Read the DOM at
several moments and check where things end up:

```js
console.log(await p.evaluate(() =>
  getComputedStyle(document.querySelector(".hero")).opacity));
```

"Lands at opacity 1 by 900ms" is checkable. A screenshot of it is not.

Two traps. `opacity` and `transform`, the properties everyone reaches for, are
blind to SVG geometry: a draw animates `stroke-dashoffset`, a carve animates
`y`, a morph animates `d`, and all three read as perfectly static unless you
ask for them. And measuring cannot tell you whether motion looks *good* — ask
the owner to watch it for that.

### Comparing two versions

Do not eyeball two tall screenshots. Real changes are routinely a few
thousandths of a percent of the pixels, invisible to a person flipping between
images.

Compare per pixel, never by an average: two glyphs appearing on a long page
cannot move a mean, so a mean-based comparison reports "nothing changed" with
complete confidence. Count differing pixels and report where they are.

Looping animation makes every capture differ and swamps the comparison. Freeze
the endless ones first, after the page has settled so entrance animations still
finish:

```js
await p.evaluate(() => {
  for (const a of document.getAnimations()) {
    if (a.effect?.getTiming?.().iterations !== Infinity) continue;
    a.currentTime = 0; a.commitStyles(); a.cancel();
  }
});
```

Pausing alone does not hold: a CSS-declared animation is owned by the style
engine, which re-syncs and undoes both a pause and a seek. This reaches CSS and
Web Animations only. A `requestAnimationFrame` loop, which includes anime.js
v4's core and anything painting a canvas, cannot be frozen this way. On such a
page compare a region that excludes it, or compare by DOM instead of pixels.

## 4. Show the owner

Bring a round, not a version. For each: the screenshots, a sentence on what
changed and why, and anything you could not resolve.

Say plainly which parts you are unsure about. An owner reviewing a design they
did not build cannot tell a deliberate choice from an accident unless you say.

Then take their feedback back to phase 3. Their reaction replaces your
self-critique on anything they comment on; keep critiquing the rest yourself.

## After a pivot, audit what you inherited

When a round changes the visual world — new palette, new ground, new type, a
different material altogether — the previous world's grammar survives it
silently. Nothing breaks. Components keep working perfectly in a world they no
longer suit, which is exactly why nobody notices.

Before showing a pivot, list everything that predates it and mark each item
*re-decided* or *inherited*:

- **Motion.** Every reveal, transition and showpiece. Entrance animations
  authored for a dark page where things emerge from the night are nonsense on a
  printed sheet: ink does not brighten as you look at it.
- **Disclosure.** Accordions, tabs, drawers, popovers. The most portable
  inherited grammar of all, because it never breaks. An accordion hiding half a
  section contradicts a page whose premise is that everything is on the sheet.
- **Structure.** Column counts, rails, timelines, grids. A device that carried
  meaning in the old world often just wastes width in the new one.
- **Copy shape.** Length, rhythm, how much is asked of the reader.

The failure is not that people skip this question. It is that they do not know
motion, disclosure and column structure are the *same* question. Ask it as one.

## Guardrails

- **The project's `CLAUDE.md` wins, verbatim.** Read it first and treat its
  hard rules as non-negotiable. This skill adds process, never permission.
- **Copy is not yours to change.** New or reworded user-facing strings are
  proposals. Mark them where the project keeps its copy, keep a running list,
  and never present copy as final.
- **Section order and information architecture are fixed** unless the owner
  opened them in question 4. Restructuring within a section is fair game.
- **Honour `prefers-reduced-motion`.** Every animation falls straight to its
  final state. Capture that mode and look at it: it is the shot that catches a
  reveal leaving whole sections stranded at `opacity: 0`.
- **Do not invent facts** about the owner, their work, or their clients.
