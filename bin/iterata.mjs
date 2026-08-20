#!/usr/bin/env node
// Capture design screenshots of a running site with Playwright.
//
// Quick mode (one shot against an already-running dev server, seconds, for
// micro-iterations):
//   iterata <label> --quick [--url http://localhost:3000]
//
// Full rig (builds, serves, captures the whole set, for checkpoints):
//   iterata [version] [--skip-build] [--port 4123] [--note "what changed"]
//
// Output: <outDir>/<version>/screens/*.jpg, or <outDir>/quick/<label>.jpg
//
// Versions are tracked in <outDir>/manifest.json and auto-increment when no
// version is given, so the tool does not need a VCS to know what it has
// already captured. When the project happens to be a git repository the
// commit is recorded alongside the run, because the useful thing a version
// points at is the code that produced it. That recording is best-effort and
// never required: iterata runs the same in a directory git has never seen.
//
// Configuration comes from iterata.config.json in the working
// directory (see config.example.json). Every field has a default, so the
// tool runs against a plain Next.js app with no config at all.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// ---------------------------------------------------------------- config

const DEFAULTS = {
  // Command that produces a production build. null skips the build step.
  buildCommand: ["npx", "next", "build"],
  // Command that serves the production build. {port} is substituted.
  startCommand: ["npx", "next", "start", "-p", "{port}"],
  port: 4123,
  devUrl: "http://localhost:3000",
  outDir: "design-lab",
  // Routes to capture, each crossed with the theme set below. A localised or
  // multi-page site lists every route worth reviewing; the default captures
  // the root only. Entries are either a path string or { path, name }, where
  // name overrides the slug that goes into the filename.
  routes: ["/"],
  // Themes to capture, in order. The first is the primary: it gets the hero
  // shot, the section crops, the mobile shot and the reduced-motion shot.
  // Every other theme gets a full-page shot only. A single-theme site should
  // set this to its one theme rather than shooting the same page twice under
  // two names. Values are passed to Playwright as colorScheme, so they must be
  // "light" or "dark".
  themes: ["dark", "light"],
  // localStorage key the theme switcher reads, so shots are deterministic.
  // next-themes uses "theme". null disables the seeding, which is what a site
  // with no theme switcher wants.
  themeStorageKey: "theme",
  // Elements that are position:fixed repeat down a fullPage capture, so they
  // are hidden for those shots and restored afterwards.
  hideOnFullPage: [],
  // Section ids captured as individual crops during the full rig.
  sections: [],
  viewports: {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  },
  // scrollStep is in pixels, every other field is milliseconds. The page is
  // walked down in scrollStep-sized jumps, pausing scrollPause at each one so
  // scroll-triggered reveals fire; settleAfter then waits out entrance
  // animations and counters before the shutter. maxScrollPasses bounds the
  // walk so an infinite-scroll page cannot spin forever.
  timing: {
    scrollStep: 500,
    scrollPause: 250,
    maxScrollPasses: 200,
    settleAfter: 2000,
    afterScrollTop: 600,
    sectionSettle: 400,
  },
  jpegQuality: 80,
};

function loadConfig(cwd) {
  const path = join(cwd, "iterata.config.json");
  if (!existsSync(path)) return { ...DEFAULTS, _source: "defaults" };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`iterata.config.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    viewports: { ...DEFAULTS.viewports, ...(raw.viewports ?? {}) },
    timing: { ...DEFAULTS.timing, ...(raw.timing ?? {}) },
    _source: path,
  };

  // routes is normalised to { path, slug } here so the capture loop never has
  // to care which of the two shapes the config used. The root route gets an
  // empty slug, which keeps single-route filenames exactly as they were
  // before routes existed.
  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    console.error('iterata.config.json: "routes" must be a non-empty array, e.g. ["/"]');
    process.exit(1);
  }
  cfg.routes = cfg.routes.map((entry) => {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      console.error(
        `iterata.config.json: every route needs a path starting with "/", got ${JSON.stringify(entry)}`
      );
      process.exit(1);
    }
    const name = typeof entry === "object" && entry !== null ? entry.name : undefined;
    const slug = name ?? path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
    return { path, slug };
  });
  const slugs = cfg.routes.map((r) => r.slug);
  const dupe = slugs.find((slug, i) => slugs.indexOf(slug) !== i);
  if (dupe !== undefined) {
    console.error(
      `iterata.config.json: two routes produce the slug "${dupe}", so their captures would overwrite each other. ` +
        `Give one of them an explicit { "path": "...", "name": "..." }.`
    );
    process.exit(1);
  }

  // themes names every capture file and is passed to Playwright as
  // colorScheme, so a bad value fails late and quietly. Check it here.
  if (!Array.isArray(cfg.themes) || cfg.themes.length === 0) {
    console.error('iterata.config.json: "themes" must be a non-empty array, e.g. ["dark"]');
    process.exit(1);
  }
  const bad = cfg.themes.filter((t) => t !== "light" && t !== "dark");
  if (bad.length) {
    console.error(`iterata.config.json: "themes" accepts only "light" and "dark", got ${bad.join(", ")}`);
    process.exit(1);
  }

  return cfg;
}

// -------------------------------------------------------------- manifest

// The version ledger. It lives beside the captures rather than in a VCS,
// because the captures themselves are normally ignored by one: keeping the
// artifacts in one place and their identity in another is how a run ends up
// with a version number nothing can resolve.
const manifestPath = (cfg) => join(cfg.outDir, "manifest.json");

function readManifest(cwd, cfg) {
  const path = resolve(cwd, manifestPath(cfg));
  if (!existsSync(path)) return { manifestVersion: 1, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.runs) ? parsed : { manifestVersion: 1, runs: [] };
  } catch {
    // A corrupt ledger must not cost you a capture. Start a fresh one and say so.
    console.warn(`warning: ${manifestPath(cfg)} is unreadable, starting a new ledger`);
    return { manifestVersion: 1, runs: [] };
  }
}

function writeManifest(cwd, cfg, manifest) {
  const path = resolve(cwd, manifestPath(cfg));
  mkdirSync(resolve(cwd, cfg.outDir), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

// vX.Y, minor bump per checkpoint. Only full-rig runs get a number; quick
// shots are scratch and keep whatever label you gave them.
function nextVersion(manifest) {
  const seen = manifest.runs
    .filter((r) => r.mode === "full")
    .map((r) => /^v(\d+)\.(\d+)$/.exec(r.version ?? ""))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2])]);
  if (!seen.length) return "v0.1";
  seen.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [major, minor] = seen[seen.length - 1];
  return `v${major}.${minor + 1}`;
}

// Best-effort, and silent when there is no repository. iterata does not
// require git; it just refuses to throw away the link when git is there.
function gitSource(cwd) {
  const run = (...a) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const sha = run("rev-parse", "--short", "HEAD");
  if (!sha) return null;
  return {
    sha,
    branch: run("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: run("status", "--porcelain") !== "",
  };
}

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? null;
};

// Flags that consume the argument after them, so their values are not mistaken
// for the label. Matched on position: indexOf() returns the first occurrence,
// which drops a label identical to an earlier flag's value.
const VALUE_FLAGS = new Set(["--url", "--port", "--config", "--route", "--note"]);
const label = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

const USAGE =
  "usage:\n" +
  "  iterata <label> --quick [--url URL] [--route /path]   one shot, running server\n" +
  "  iterata [version] [--skip-build] [--port N] [--note]  full rig, every configured route\n" +
  "  iterata --list                                        versions captured so far\n" +
  "\n" +
  "The version is optional: omitted, the next one is taken from the ledger at\n" +
  "<outDir>/manifest.json. --note records what changed, so the history is\n" +
  "readable without keeping a log by hand.";

const cwd = process.cwd();
const cfg = loadConfig(cwd);
const quick = flag("quick");
const skipBuild = flag("skip-build");
const note = value("note");

// Bare `iterata` now captures a checkpoint rather than printing usage, so help
// needs its own flag: nobody should trigger a production build by asking what
// the arguments are.
if (flag("help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// --list answers from the ledger alone: no browser, no server, no build.
if (flag("list")) {
  const { runs } = readManifest(cwd, cfg);
  const full = runs.filter((r) => r.mode === "full");
  if (!full.length) {
    console.log(`no versions captured yet (ledger: ${manifestPath(cfg)})`);
    process.exit(0);
  }
  for (const r of full) {
    const when = r.createdAt?.slice(0, 16).replace("T", " ") ?? "";
    const src = r.source ? ` ${r.source.sha}${r.source.dirty ? "+dirty" : ""}` : "";
    console.log(`${r.version.padEnd(8)} ${when}  ${String(r.shots?.length ?? 0).padStart(2)} shots${src}`);
    if (r.note) console.log(`         ${r.note}`);
  }
  process.exit(0);
}

// Quick mode names a scratch file, so it needs a label from you. The full rig
// numbers itself.
if (quick && !label) {
  console.error("a quick shot needs a label, e.g. `iterata hero-spacing --quick`\n\n" + USAGE);
  process.exit(1);
}

const manifest = readManifest(cwd, cfg);
const version = quick ? label : (label ?? nextVersion(manifest));

const port = Number(value("port")) || cfg.port;
const baseUrl = quick ? (value("url") ?? cfg.devUrl) : `http://localhost:${port}`;
const outDir = quick
  ? join(cfg.outDir, "quick")
  : join(cfg.outDir, version, "screens");

if (!quick && !label) console.log(`version ${version} (auto, from ${manifestPath(cfg)})`);

mkdirSync(resolve(cwd, outDir), { recursive: true });

// ---------------------------------------------------------------- server

let server = null;

function startServer() {
  if (cfg.buildCommand && !skipBuild) {
    console.log("building...");
    const [cmd, ...rest] = cfg.buildCommand;
    const build = spawnSync(cmd, rest, { stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  console.log(`starting server on :${port}...`);
  const [cmd, ...rest] = cfg.startCommand.map((p) => p.replace("{port}", String(port)));
  server = spawn(cmd, rest, { detached: true, stdio: "ignore" });
}

const stopServer = () => {
  if (!server) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on ${baseUrl} never became ready`);
}

// --------------------------------------------------------------- capture

// Scroll to the bottom in steps so every scroll-triggered reveal fires, wait
// for entrance timelines and counters to finish, then return to the top.
//
// The height is re-read every iteration: a page that grows as it is scrolled
// (lazy sections, infinite feeds) is taller at the bottom than it was at the
// top, and a height sampled once leaves the tail unvisited and unrevealed.
//
// KNOWN WEAKNESS: the waiting is fixed-timing, not a real signal. A page with
// an animation longer than settleAfter is captured mid-flight, and a static
// page pays the full wait for nothing. See REPORT.md.
async function settle(page, timing) {
  await page.waitForLoadState("load");

  const walk = await page.evaluate(
    async ({ step, pause, maxPasses }) => {
      // The scroller is html on most pages and body on a few; take whichever
      // reports the taller document so neither layout under-scrolls.
      const height = () =>
        Math.max(
          document.scrollingElement?.scrollHeight ?? 0,
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        );

      let y = 0;
      let passes = 0;
      while (y < height() - window.innerHeight && passes < maxPasses) {
        y += step;
        window.scrollTo(0, y);
        passes += 1;
        await new Promise((r) => setTimeout(r, pause));
      }
      return { reached: y, height: height(), capped: passes >= maxPasses };
    },
    { step: timing.scrollStep, pause: timing.scrollPause, maxPasses: timing.maxScrollPasses },
  );

  if (walk.capped) {
    console.warn(
      `  ! scroll walk hit maxScrollPasses (${timing.maxScrollPasses}) at ${walk.reached}px of ${walk.height}px — the tail of this page was never scrolled into view`,
    );
  }

  await page.waitForTimeout(timing.settleAfter);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(timing.afterScrollTop);
}

// Resolved against the origin, so a devUrl that already carries a path or a
// trailing slash does not produce a double slash or swallow the route.
const urlFor = (route) => new URL(route.path, baseUrl).href;

async function newPage(browser, { width, height, theme, route, reduce = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: reduce ? "reduce" : "no-preference",
    deviceScaleFactor: 1,
  });
  if (cfg.themeStorageKey) {
    await context.addInitScript(
      ([key, t]) => localStorage.setItem(key, t),
      [cfg.themeStorageKey, theme]
    );
  }
  const page = await context.newPage();
  const res = await page.goto(urlFor(route), { waitUntil: "domcontentloaded" });
  // A 404 on a mistyped route still screenshots happily, and the result looks
  // like a design regression rather than a config error. Say so instead.
  if (res && !res.ok()) {
    console.warn(`  ! ${urlFor(route)} responded ${res.status()} — the capture below is that response, not the page`);
  }
  await settle(page, cfg.timing);
  return { context, page };
}

// Route slug goes in front so a multi-route set groups by route when listed.
// The root route has an empty slug, so single-route projects keep the exact
// filenames they had before routes existed.
const shot = (route, name) => (route.slug ? `${route.slug}-${name}` : name);

// Every capture registers itself, so the ledger records what was actually
// written rather than what the code intended to write.
const captured = [];
const jpg = (name) => {
  captured.push(`${name}.jpg`);
  return { path: join(outDir, `${name}.jpg`), type: "jpeg", quality: cfg.jpegQuality };
};

function record(mode) {
  manifest.runs.push({
    version,
    mode,
    createdAt: new Date().toISOString(),
    outDir,
    shots: captured,
    routes: cfg.routes.map((r) => r.path),
    themes: cfg.themes,
    ...(note ? { note } : {}),
    source: gitSource(cwd),
  });
  writeManifest(cwd, cfg, manifest);
}

// Returns the number of elements actually matched, so a stale selector after
// a markup change is reported instead of silently producing a capture with
// the header repeated down the whole page.
const setFixedDisplay = (page, selectors, display) =>
  page.evaluate(
    ([sels, v]) => {
      let hit = 0;
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          el.style.display = v;
          hit++;
        }
      }
      return hit;
    },
    [selectors, display]
  );

async function fullPageShot(page, name) {
  const hidden = await setFixedDisplay(page, cfg.hideOnFullPage, "none");
  if (cfg.hideOnFullPage.length && hidden === 0) {
    console.warn(
      `warning: hideOnFullPage matched nothing (${cfg.hideOnFullPage.join(", ")}). ` +
        `Fixed elements will repeat down ${name}.jpg.`
    );
  }
  await page.screenshot({ ...jpg(name), fullPage: true });
  await setFixedDisplay(page, cfg.hideOnFullPage, "");
}

// ------------------------------------------------------------------ main

if (!quick) startServer();
await waitForServer();
console.log(`capturing (config: ${cfg._source})...`);
const browser = await chromium.launch();

const [primary, ...secondary] = cfg.themes;

if (quick) {
  // Quick mode stays a single shot no matter how many routes are configured,
  // because its whole point is a few seconds. --route picks a different one.
  const wanted = value("route");
  const route = wanted
    ? cfg.routes.find((r) => r.path === wanted) ?? { path: wanted, slug: "" }
    : cfg.routes[0];
  const { context, page } = await newPage(browser, {
    ...cfg.viewports.desktop,
    theme: primary,
    route,
  });
  await fullPageShot(page, version);
  await context.close();
  await browser.close();
  record("quick");
  console.log(`done: ${join(outDir, `${version}.jpg`)}`);
  process.exit(0);
}

for (const route of cfg.routes) {
  if (route.slug) console.log(`  route ${route.path}`);

  // 1. Desktop, primary theme: full page, hero viewport, one crop per section.
  {
    const { context, page } = await newPage(browser, {
      ...cfg.viewports.desktop,
      theme: primary,
      route,
    });
    await fullPageShot(page, shot(route, `desktop-${primary}-full`));
    await page.screenshot(jpg(shot(route, `desktop-${primary}-hero`)));
    for (const id of cfg.sections) {
      const target = page.locator(`#${id}`);
      if ((await target.count()) === 0) {
        console.warn(`warning: section #${id} not found on ${route.path}, skipping crop`);
        continue;
      }
      await target.scrollIntoViewIfNeeded();
      await page.waitForTimeout(cfg.timing.sectionSettle);
      await target.screenshot(jpg(shot(route, `desktop-${primary}-${id}`)));
    }
    await context.close();
  }

  // 2. Mobile, primary theme, full page.
  {
    const { context, page } = await newPage(browser, {
      ...cfg.viewports.mobile,
      theme: primary,
      route,
    });
    await fullPageShot(page, shot(route, `mobile-${primary}-full`));
    await context.close();
  }

  // 3. Desktop, every other theme, full page. Empty on a single-theme site.
  for (const theme of secondary) {
    const { context, page } = await newPage(browser, {
      ...cfg.viewports.desktop,
      theme,
      route,
    });
    await fullPageShot(page, shot(route, `desktop-${theme}-full`));
    await context.close();
  }

  // 4. Reduced motion: content must land in its final state with no animation.
  //    Captured only. Nothing asserts it, a human still compares. See REPORT.md.
  {
    const { context, page } = await newPage(browser, {
      ...cfg.viewports.desktop,
      theme: primary,
      route,
      reduce: true,
    });
    await fullPageShot(page, shot(route, `desktop-${primary}-reduced-motion`));
    await context.close();
  }
}

await browser.close();
stopServer();
record("full");
console.log(`done: ${outDir}`);
process.exit(0);
