# Setting iterata up in a project

You are installing two pieces that work together:

- **the CLI** (`iterata`), which takes the screenshots
- **the skill** (`.claude/skills/iterata/SKILL.md`), which teaches Claude Code
  the loop those screenshots are for

The CLI is useful on its own. The skill without the CLI is not, so install in
that order.

This whole page is a once-per-project job. Hand it to Claude and let it work
through the steps, or run them yourself.

---

## 1. Install

```bash
npm i -D github:KristofferTolboll2/iterata
npx playwright install chromium
```

Then a script, so the loop has a project-local entry point:

```json
"scripts": {
  "shots": "iterata"
}
```

Check it resolves before going further. `npx iterata --help` should print usage
rather than "command not found". (Bare `iterata` captures a checkpoint, so use
`--help` when you only want to look.)

## 2. Install the skill

```bash
mkdir -p .claude/skills/iterata
cp node_modules/iterata/skill/SKILL.md .claude/skills/iterata/SKILL.md
```

If the project already has a design-iteration skill of its own, do not keep
both. Two skills claiming the same loop is a coin flip over which one Claude
follows. Pick one and delete the other.

## 3. Configure

```bash
cp node_modules/iterata/config.example.json iterata.config.json
```

Every field has a default, and the tool runs with no config at all against a
plain Next.js app. The defaults are still a guess about your project, and five
of them are worth deciding deliberately.

### `themes`

Defaults to `["dark", "light"]`. The first entry is the primary: it gets the
hero shot, the section crops, the mobile shot and the reduced-motion shot.
Every other entry adds one full-page shot.

**If your site has one theme, list only that one.** Otherwise the rig captures
the same page twice under two names, one of which claims a theme the site does
not have. Check before assuming: look for a theme provider, and for whether
your CSS actually defines a second palette.

```bash
grep -rn "prefers-color-scheme" src/ | head
grep -rc "dark:" src/**/*.css
```

Only `"light"` and `"dark"` are accepted, because the value is passed to
Playwright as `colorScheme`.

### `themeStorageKey`

The localStorage key your theme switcher reads, seeded before load so shots do
not depend on the OS setting. `next-themes` uses `"theme"`. **Set it to `null`
if there is no theme switcher** — otherwise you are writing a key nothing
reads and quietly believing it did something.

### `routes`

Defaults to `["/"]`. The full rig captures every route crossed with every
theme. A single-page site leaves this alone. A localised or multi-page site
lists each route worth reviewing:

```json
"routes": ["/", "/da", { "path": "/work/case-study", "name": "case" }]
```

The root route contributes no filename prefix, so single-route projects keep
plain names. Every other route prefixes its slug, derived from the path unless
you give it a `name`. Two routes that would produce the same slug are rejected
at config load rather than silently overwriting each other's captures.

### `hideOnFullPage`

CSS selectors for `position: fixed` elements. They repeat down a full-page
capture, so they are hidden for those shots and restored afterwards. The hero
shot keeps them, which is where you review them.

Find yours rather than guessing:

```bash
grep -rn "fixed" src/components/*.tsx | grep -i "nav\|header\|dock\|bar"
```

A selector that matches nothing prints a warning on every run. That warning is
the point — it is how you find out a class name changed.

`hideOnSection` covers the same problem for section crops and defaults to
`hideOnFullPage`. It is worth setting separately when something belongs at the
foot of a whole page but ruins a crop: a bottom scrim renders correctly once at
the end of a full page, and washes out the bottom of every crop it overlaps.

### `sections`

Element ids captured as individual crops. These are the parts of the page you
actually iterate on.

```bash
grep -o 'id="[a-z-]*"' src/app/page.tsx | sort -u
```

A missing id warns and skips rather than failing the run, so a stale entry
costs you a crop, not a checkpoint.

### `buildCommand` / `startCommand` / `port` / `devUrl`

Defaults assume Next.js. `{port}` is substituted into `startCommand`. Set
`buildCommand` to `null` for a project that serves straight from source.
`devUrl` is what quick mode hits, and defaults to `http://localhost:3000`.

## 4. Prove it works before you trust it

```bash
npx iterata setup-check
```

Read the output, do not just check that files appeared. A run that produces
eight good-looking JPEGs and three warnings is a broken config, and the
screenshots will look plausible enough that you will not notice for a week.

| What you see | What it means |
|---|---|
| `hideOnFullPage matched nothing` | Your selector is stale. Fixed chrome will repeat down every full-page shot. |
| `section #x not found` | Stale id in `sections`, or you renamed it. |
| `responded 404` | A route in `routes` does not exist. The capture is of the 404 page. |
| `scroll walk hit maxScrollPasses` | The page grows faster than it is scrolled. Raise `timing.scrollStep`, or the tail was never revealed. |

Then open the full-page shot and check three things: the fixed header appears
once and not repeated down the image, no section is blank where it should have
content, and the theme is the one you expected.

Delete `design-lab/setup-check/` afterwards.

## 5. Versioning

iterata versions itself. `<outDir>/manifest.json` is the ledger: every run
appends to it, and a checkpoint with no version argument takes the next number.

```bash
iterata --note "first pass at the hero"   # -> v0.1
iterata --note "tightened the rhythm"     # -> v0.2
iterata v1.0 --note "accepted"            # explicit, when a round is accepted
iterata --list                            # read the history back
```

```
v0.1     2026-08-20 05:13   8 shots  a41c2f9
         first pass at the hero
v0.2     2026-08-20 05:14   8 shots  a41c2f9+dirty
         tightened the rhythm
```

`--note` is why there is no log file to maintain. The description lives with
the run that it describes.

**None of this requires version control.** iterata runs the same in a directory
git has never seen. When the project *is* a repository, the short SHA, branch
and dirty flag are recorded against each version, because the useful thing a
version number points at is the code that produced it. That is a recording, not
a requirement, and nothing fails when it is absent.

If you do use git, two conventions are worth keeping: iterate on a branch
rather than the default one, so an exploration that goes nowhere costs nothing,
and add the output directory to `.gitignore` — screenshots are large,
regenerable, and change on every run.

```
design-lab
```

---

## Working the loop with Claude

Once setup is done, you do not run the CLI by hand very often. You say what you
want changed, and the skill drives the loop.

**Micro-iterations** are the default and the thing that makes this worth having.
One focused visible change, one shot, your reaction, repeat. Seconds per turn.
Start the dev server once and leave it running:

```bash
npm run dev &
```

Then work in plain language. "Tighten the spacing above the section titles."
Claude edits, runs `iterata <label> --quick`, looks at the shot, and shows you
the path. You react. That reaction is the whole feedback loop at this speed,
which is why the skill forbids spawning review agents between iterations.

**Checkpoints** bundle a coherent batch. Build and lint must pass, then the
full rig runs, takes the next version number, records what changed, and updates
the gallery. Ask for one when a batch feels done, not after every change.

Two things to know going in:

**A still frame cannot review an animation.** This is the loop's largest blind
spot and it is not fixed. When the change is motion, the skill is instructed to
say so and ask you to watch it rather than reporting an animation as working on
the strength of one screenshot. Take that seriously; a screenshot of a
mid-flight animation looks like a broken layout, and a screenshot of a
never-started animation looks fine.

**The project's `CLAUDE.md` wins over the skill, verbatim.** The skill adds
process, never permission. So a stale `CLAUDE.md` actively steers the loop
wrong — if it describes a palette, a section list or a motion policy the code
has since moved away from, fix the document before you start iterating.

## Troubleshooting

**`iterata: command not found`** — not installed, or installed but the bin was
not made executable. Check `ls -l node_modules/.bin/iterata` resolves to a file
with an executable bit.

**The shot does not show the change I just made** — suspect the dev server
before you suspect the edit. Restart it and reshoot rather than editing again
on top of a stale frame.

**Every full-page capture has the header repeated down it** — `hideOnFullPage`
is not matching. You will have been warned about this on every run.

**The bottom of the page is blank in the capture** — the page grows as it is
scrolled and the walk did not keep up. Check for a `maxScrollPasses` warning.

**Light and dark shots look identical** — the site has one theme. Set `themes`
to just that one and drop `themeStorageKey`.

**The capture is a login or 401 page** — the project gates preview behind auth.
Clear the gating env var for the capture run.
