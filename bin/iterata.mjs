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
  // Ambient motion makes every capture land on a different frame, so two runs
  // of an unchanged page differ and a diff fills with regions that mean
  // nothing. A report that always shows regions teaches the reader to skim
  // past them, and then a real change hides among the petals. Freezing runs
  // after the page has settled, so entrance animations finish first and only
  // the endless ones are stopped. Set false to see motion as it lands.
  freezeMotion: true,
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
  // The same problem is worse for a section crop: fixed chrome does not repeat
  // there, it composites straight into the middle of the frame, and a crop that
  // silently contains the dock or a bottom scrim reads as a design regression
  // rather than an artifact. null means reuse hideOnFullPage; set it when a
  // crop needs to hide something a full page can keep, such as a footer scrim
  // that sits correctly at the foot of a whole page but washes out a band.
  hideOnSection: null,
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
  if (cfg.hideOnSection == null) cfg.hideOnSection = cfg.hideOnFullPage;

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
const VALUE_FLAGS = new Set([
  "--url", "--port", "--config", "--route", "--note", "--selectors", "--at", "--props",
]);
const label = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

const USAGE =
  "usage:\n" +
  "  iterata <label> --quick [--url URL] [--route /path]   one shot, running server\n" +
  "  iterata [version] [--skip-build] [--port N] [--note]  full rig, every configured route\n" +
  "  iterata --list                                        versions captured so far\n" +
  "  iterata --gallery                                     build <outDir>/gallery.html\n" +
  "  iterata --diff <vA> <vB>                              before/after report for two versions\n" +
  "  iterata <label> --scratch                             capture without spending a version\n" +
  "  iterata [label] --probe --selectors .a,.b [--at 0,400] read computed style over time\n" +
  "\n" +
  "The version is optional: omitted, the next one is taken from the ledger at\n" +
  "<outDir>/manifest.json. --note records what changed, so the history is\n" +
  "readable without keeping a log by hand.";

const cwd = process.cwd();
const cfg = loadConfig(cwd);
const quick = flag("quick");
const skipBuild = flag("skip-build");
const note = value("note");
// A scratch run captures and is recorded so it can be diffed, but is not a
// design version: it does not take a number, and does not reach --list or the
// gallery. Verifying tool behaviour against a real project should not spend
// version numbers the gallery then reads from.
const scratch = flag("scratch");

// ----------------------------------------------------------------- probe

// A still frame cannot review motion, and the fixes that make captures
// deterministic work by stopping motion, which is the opposite of what you
// need when the motion IS the change. A probe reads the DOM instead: what an
// element's computed style actually is at a given moment. It does not care
// what frame anything is on, so nothing here needs settling or freezing, and
// an assertion like "ends at opacity 1" is checkable in a way a contact sheet
// of stills is not.
const PROBE_PROPS = ["opacity", "transform", "visibility", "display"];

async function runProbe(cwd, cfg, label, selectors, times, props, url) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: cfg.viewports.desktop,
    colorScheme: cfg.themes[0],
    deviceScaleFactor: 1,
  });
  if (cfg.themeStorageKey) {
    await context.addInitScript(([k, t]) => localStorage.setItem(k, t), [cfg.themeStorageKey, cfg.themes[0]]);
  }
  const page = await context.newPage();

  // Deliberately no settle() and no freezeMotion(). The obvious reason is that
  // both would destroy the measurement, but the load-bearing one is stronger:
  // the sample at 0ms is the only view of the page before anything has
  // hydrated or animated, which is what a crawler and a reader without JS get.
  // Settling here for consistency with the capture modes would delete that
  // view, and it would look like a tidy-up rather than a loss.
  const res = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (res && !res.ok()) console.warn(`  ! ${url} responded ${res.status()}`);
  const started = Date.now();

  const samples = [];
  for (const t of times) {
    const wait = t - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
    const at = Date.now() - started;
    const row = await page.evaluate(
      ({ sels, wanted }) =>
        sels.map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, missing: true };
          const cs = getComputedStyle(el);
          const out = { sel };
          for (const p of wanted) out[p] = cs.getPropertyValue(p);
          return out;
        }),
      { sels: selectors, wanted: props },
    );
    samples.push({ requested: t, actual: at, values: row });
  }
  await browser.close();

  const width = Math.max(...selectors.map((s) => s.length), 8);
  console.log(`${"time".padEnd(8)}${"selector".padEnd(width + 2)}${props.join("  ")}`);
  for (const s of samples) {
    for (const v of s.values) {
      const cells = v.missing
        ? "(no element matches)"
        : props.map((p) => v[p]).join("  ");
      console.log(`${String(s.actual + "ms").padEnd(8)}${v.sel.padEnd(width + 2)}${cells}`);
    }
  }
  // A missing selector is the difference between "it ends at opacity 1" and
  // "nothing was measured", and those must not read the same.
  const missing = [...new Set(samples.flatMap((s) => s.values.filter((v) => v.missing).map((v) => v.sel)))];
  if (missing.length) console.warn(`\nwarning: matched no element: ${missing.join(", ")}`);

  // The same failure wearing different clothes. An element whose sampled
  // properties never move reads as "this does not animate", and that is wrong
  // whenever the motion is driving a property nobody asked for. SVG geometry
  // is the common case: a draw animates stroke-dashoffset, a carve animates y,
  // a morph animates d, and none of those are in the default set. Showpiece
  // work is overwhelmingly SVG, so the default question is blind on exactly
  // the category this is for.
  if (times.length > 1) {
    const flat = selectors.filter((sel) => !missing.includes(sel));
    const stuck = flat.filter((sel) =>
      props.every((prop) => {
        const seen = new Set(
          samples.map((s) => s.values.find((v) => v.sel === sel)?.[prop]).filter((v) => v !== undefined),
        );
        return seen.size <= 1;
      }),
    );
    if (stuck.length) {
      console.warn(
        `\nwarning: no sampled property changed for ${stuck.join(", ")}.\n` +
          `  That is not the same as "does not animate": the motion may be driving a\n` +
          `  property you did not request. SVG geometry is the usual culprit, so try\n` +
          `  --props stroke-dashoffset,y,x,width,height,d,r,cx,cy`,
      );
    }
  }

  if (label) {
    const out = join(cfg.outDir, "probe", `${label}.json`);
    mkdirSync(resolve(cwd, join(cfg.outDir, "probe")), { recursive: true });
    writeFileSync(resolve(cwd, out), JSON.stringify({ url, selectors, props, samples }, null, 2) + "\n");
    console.log(`\nwrote ${out}`);
  }
}

// ------------------------------------------------------------------ diff

// Per-pixel, deliberately. A row mean or an image mean will report "nothing
// changed" when something did: two glyphs appearing on a 6040px page cannot
// move an average, and the answer comes back clean and confident. A false
// negative in a diff is worse than a false positive, because nothing prompts
// you to check it. Count pixels over a threshold and report where they are.
const DIFF_THRESHOLD = 24;
const DIFF_CELL = 16;

async function diffImages(page, aData, bData, threshold) {
  return page.evaluate(
    async ({ a, b, t, cell }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("decode failed"));
          im.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const pixels = (im) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(im, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const da = pixels(ia);
      const db = pixels(ib);

      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      const counts = new Uint32Array(cols * rows);
      let changed = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d = Math.max(
            Math.abs(da[i] - db[i]),
            Math.abs(da[i + 1] - db[i + 1]),
            Math.abs(da[i + 2] - db[i + 2]),
          );
          if (d > t) {
            changed++;
            counts[((y / cell) | 0) * cols + ((x / cell) | 0)]++;
          }
        }
      }
      // No per-cell minimum. A floor here could only ever hide a small real
      // change, and a diff that misses something reports clean, which is the
      // failure nobody goes looking for.
      const grid = new Uint8Array(cols * rows);
      for (let i = 0; i < counts.length; i++) if (counts[i] > 0) grid[i] = 1;

      // Flood fill the marked cells so adjacent changes become one region
      // rather than a scatter of boxes the reader has to reassemble.
      const boxes = [];
      const seen = new Uint8Array(grid.length);
      for (let i = 0; i < grid.length; i++) {
        if (!grid[i] || seen[i]) continue;
        let x0 = i % cols, x1 = x0, y0 = (i / cols) | 0, y1 = y0;
        const queue = [i];
        seen[i] = 1;
        while (queue.length) {
          const c = queue.pop();
          const cx = c % cols, cy = (c / cols) | 0;
          if (cx < x0) x0 = cx;
          if (cx > x1) x1 = cx;
          if (cy < y0) y0 = cy;
          if (cy > y1) y1 = cy;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const n = ny * cols + nx;
            if (grid[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
          }
        }
        boxes.push({
          x: x0 * cell,
          y: y0 * cell,
          w: Math.min((x1 - x0 + 1) * cell, w - x0 * cell),
          h: Math.min((y1 - y0 + 1) * cell, h - y0 * cell),
        });
      }
      boxes.sort((p, q) => p.y - q.y || p.x - q.x);
      return {
        changed,
        total: w * h,
        width: w,
        height: h,
        sizeA: [ia.width, ia.height],
        sizeB: [ib.width, ib.height],
        boxes,
      };
    },
    { a: aData, b: bData, t: threshold, cell: DIFF_CELL },
  );
}

// The report is the deliverable, not the pixel count. Each changed region is
// cropped from both versions and shown side by side at the same offset, so the
// reader sees what moved instead of being told how much did.
function diffReport(cfg, a, b, results, onlyA, onlyB) {
  const esc = (t) =>
    String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rel = (run, shot) => `${run.outDir.split("/").slice(1).join("/")}/${shot}`;

  const pane = (run, shot, box) =>
    `<div class="pane" style="width:${box.w}px;height:${box.h}px;` +
    `background-image:url('${esc(rel(run, shot))}');` +
    `background-position:-${box.x}px -${box.y}px"></div>`;

  const changed = results.filter((r) => r.changed > 0);
  const same = results.filter((r) => r.changed === 0);

  const body = changed
    .map((r) => {
      const regions = r.boxes
        .map(
          (box, i) =>
            `<div class="region"><p class="rlabel">region ${i + 1} &middot; ${box.w}&times;${box.h} at ${box.x},${box.y}</p>` +
            `<div class="pair"><figure>${pane(a, r.shot, box)}<figcaption>${esc(a.version)}</figcaption></figure>` +
            `<figure>${pane(b, r.shot, box)}<figcaption>${esc(b.version)}</figcaption></figure></div></div>`,
        )
        .join("");
      return `<section><h2>${esc(r.shot)}</h2><p class="meta">${r.changed.toLocaleString()} pixels differ by more than ${DIFF_THRESHOLD} &middot; ${r.pct.toFixed(4)}% of ${r.width}&times;${r.height} &middot; ${r.boxes.length} region${r.boxes.length === 1 ? "" : "s"}</p>${regions}</section>`;
    })
    .join("");

  const notes = [
    same.length ? `<li>${same.length} shot${same.length === 1 ? "" : "s"} identical: ${same.map((r) => esc(r.shot)).join(", ")}</li>` : "",
    onlyA.length ? `<li>Only in ${esc(a.version)}: ${onlyA.map(esc).join(", ")}</li>` : "",
    onlyB.length ? `<li>Only in ${esc(b.version)}: ${onlyB.map(esc).join(", ")}</li>` : "",
  ].filter(Boolean).join("");

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.version)} to ${esc(b.version)}</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#111;--dim:#666;--line:#e5e5e5;--mark:#d33}
  @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--dim:#999;--line:#333;--mark:#f66}}
  body{margin:0;padding:2rem 1.5rem;background:var(--bg);color:var(--fg);
    font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin-inline:auto}
  h1{font-size:1.5rem;margin:0}
  .lede{color:var(--dim);margin:.5rem 0 2rem;max-width:70ch}
  .note{margin:0 0 1rem;padding:0 0 0 1.1rem;color:var(--dim);font-size:14px}
  section{border-top:1px solid var(--line);padding:1.5rem 0}
  h2{font:14px ui-monospace,monospace;margin:0 0 .25rem}
  .meta{margin:0 0 1rem;color:var(--dim);font:13px ui-monospace,monospace}
  .region{margin:0 0 1.5rem}
  .rlabel{margin:0 0 .4rem;color:var(--mark);font:12px ui-monospace,monospace}
  .pair{display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-start}
  figure{margin:0}
  .pane{background-repeat:no-repeat;border:1px solid var(--line);border-radius:3px;
    max-width:100%}
  figcaption{margin-top:.3rem;color:var(--dim);font:12px ui-monospace,monospace}
</style>
<h1>${esc(a.version)} &rarr; ${esc(b.version)}</h1>
<p class="lede">${esc(b.note ?? "")}</p>
${notes ? `<ul class="note">${notes}</ul>` : ""}
${body || "<p>Nothing differs by more than the threshold.</p>"}
`;
}

async function runDiff(cwd, cfg, va, vb) {
  const { runs } = readManifest(cwd, cfg);
  // Scratch runs are diffable: verifying tool behaviour against a real project
  // is exactly when you want a before and after.
  const find = (v) =>
    [...runs].reverse().find((r) => (r.mode === "full" || r.mode === "scratch") && r.version === v);
  const a = find(va), b = find(vb);
  for (const [v, r] of [[va, a], [vb, b]]) {
    if (!r) {
      console.error(`no full-rig version "${v}" in ${manifestPath(cfg)}. iterata --list shows what there is.`);
      process.exit(1);
    }
  }

  const shared = (a.shots ?? []).filter((sh) => (b.shots ?? []).includes(sh));
  const onlyA = (a.shots ?? []).filter((sh) => !(b.shots ?? []).includes(sh));
  const onlyB = (b.shots ?? []).filter((sh) => !(a.shots ?? []).includes(sh));
  if (!shared.length) {
    console.error(`${va} and ${vb} share no shot names, so there is nothing to compare.`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("about:blank");

  const dataUrl = (dir, shot) =>
    `data:image/jpeg;base64,${readFileSync(resolve(cwd, dir, shot)).toString("base64")}`;

  const results = [];
  for (const shot of shared) {
    const r = await diffImages(page, dataUrl(a.outDir, shot), dataUrl(b.outDir, shot), DIFF_THRESHOLD);
    const pct = (r.changed / r.total) * 100;
    results.push({ shot, ...r, pct });
    const grew = String(r.sizeA) !== String(r.sizeB) ? `  (size ${r.sizeA.join("x")} -> ${r.sizeB.join("x")}, compared to the overlap)` : "";
    console.log(
      `  ${shot.padEnd(38)} ${String(r.changed).padStart(8)} px  ${pct.toFixed(4).padStart(8)}%  ${String(r.boxes.length).padStart(3)} region${r.boxes.length === 1 ? "" : "s"}${grew}`,
    );
  }
  await browser.close();

  const out = join(cfg.outDir, `diff-${va}-${vb}.html`);
  writeFileSync(resolve(cwd, out), diffReport(cfg, a, b, results, onlyA, onlyB));
  const totalChanged = results.reduce((n, r) => n + r.changed, 0);
  console.log(
    totalChanged === 0
      ? `\nNo pixel differs by more than ${DIFF_THRESHOLD}. That is a real result, not a failure to look: the comparison is per-pixel, not an average.`
      : `\nwrote ${out}`,
  );
}

// The skill's checkpoint step asks for a gallery. The ledger already holds
// everything one needs, so build it from there rather than leaving each run to
// hand-roll an HTML file and produce a differently shaped project every time.
function writeGallery(cwd, cfg) {
  const { runs } = readManifest(cwd, cfg);
  const full = runs.filter((r) => r.mode === "full");
  if (!full.length) {
    console.error(`nothing to build a gallery from yet (ledger: ${manifestPath(cfg)})`);
    process.exit(1);
  }
  const esc = (t) =>
    String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Relative to the gallery file, which sits at the root of outDir.
  const rel = (run, shot) => `${run.outDir.split("/").slice(1).join("/")}/${shot}`;

  const sections = full
    .map((r) => {
      // Branch is surfaced per version: a ledger spanning branches would
      // otherwise interleave them under one ascending list of numbers.
      const src = r.source
        ? `${esc(r.source.sha)}${r.source.dirty ? " +dirty" : ""}${r.source.branch ? ` &middot; ${esc(r.source.branch)}` : ""}`
        : "no repository";
      const shots = (r.shots ?? [])
        .map(
          (sh) =>
            `<figure><a href="${esc(rel(r, sh))}"><img loading="lazy" src="${esc(rel(r, sh))}" alt="${esc(sh)}"></a><figcaption>${esc(sh)}</figcaption></figure>`
        )
        .join("");
      return `<section><h2>${esc(r.version)}</h2><p class="meta">${esc(r.createdAt?.slice(0, 16).replace("T", " ") ?? "")} &middot; ${src}</p>${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}<div class="grid">${shots}</div></section>`;
    })
    .join("");

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design versions</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#111;--dim:#666;--line:#e5e5e5}
  @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--dim:#999;--line:#333}}
  body{margin:0;padding:2rem 1.5rem;background:var(--bg);color:var(--fg);
    font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin-inline:auto}
  h1{font-size:1.5rem;margin:0 0 2rem}
  section{border-top:1px solid var(--line);padding:2rem 0}
  h2{font-size:1.25rem;margin:0 0 .25rem}
  .meta{margin:0;color:var(--dim);font:13px ui-monospace,monospace}
  .note{margin:.5rem 0 0;max-width:60ch}
  .grid{display:grid;gap:1rem;margin-top:1.5rem;
    grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
  figure{margin:0}
  img{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:4px}
  figcaption{margin-top:.4rem;color:var(--dim);font:12px ui-monospace,monospace;
    overflow-wrap:anywhere}
</style>
<h1>Design versions</h1>
${sections}
`;
  const out = join(cfg.outDir, "gallery.html");
  writeFileSync(resolve(cwd, out), html);
  console.log(`wrote ${out} (${full.length} version${full.length === 1 ? "" : "s"})`);
}

// Bare `iterata` now captures a checkpoint rather than printing usage, so help
// needs its own flag: nobody should trigger a production build by asking what
// the arguments are.
if (flag("help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// --probe runs against a live page like quick mode, but measures instead of
// photographing, so it is the one mode that can review motion.
if (flag("probe")) {
  const selectors = (value("selectors") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!selectors.length) {
    console.error("--probe needs --selectors, e.g. --selectors '.hero-name,.statue'\n\n" + USAGE);
    process.exit(1);
  }
  // Empty entries are dropped before conversion: Number("") is 0, so an empty
  // --at would otherwise become a silent single sample at time zero.
  const times = (value("at") || "0,250,500,1000,2000,3000")
    .split(",").map((x) => x.trim()).filter(Boolean)
    .map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!times.length) {
    console.error("--at needs at least one non-negative number of milliseconds\n\n" + USAGE);
    process.exit(1);
  }
  const props = (value("props") ?? PROBE_PROPS.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
  await runProbe(cwd, cfg, label, selectors, times, props, value("url") ?? cfg.devUrl);
  process.exit(0);
}

// --diff takes two versions and needs no server, build or capture.
if (flag("diff")) {
  const i = args.indexOf("--diff");
  const [va, vb] = [args[i + 1], args[i + 2]];
  if (!va || !vb || va.startsWith("--") || vb.startsWith("--")) {
    console.error("usage: iterata --diff <versionA> <versionB>\n\n" + USAGE);
    process.exit(1);
  }
  await runDiff(cwd, cfg, va, vb);
  process.exit(0);
}

if (flag("gallery")) {
  writeGallery(cwd, cfg);
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
if (scratch && !label) {
  console.error("a scratch run needs a label, e.g. `iterata freeze-check --scratch`\n\n" + USAGE);
  process.exit(1);
}

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
  if (cfg.freezeMotion) await freezeMotion(page);
  return { context, page };
}

// Runs only after settle(), which matters more than it looks: pausing before
// entrance animations finish would freeze content halfway in and photograph a
// page that never existed.
//
// Only endless animations are touched, so finite ones keep whatever end state
// they filled to. Each is seeked to its start, that frame is written to the
// element as inline style, and the animation is then cancelled.
//
// Pausing alone does not hold. A CSS-declared animation is owned by the style
// engine, which re-syncs it on the next recalculation and undoes both the pause
// and the seek: measured, a paused-and-seeked element still read currentTime
// 24ms and two runs still differed. Committing the frame and removing the
// animation leaves nothing to re-sync, and two independent loads then produce
// byte-identical transforms.
//
// This cannot reach a requestAnimationFrame loop painting a canvas. Nothing
// declarative can. A site with a live canvas backdrop will still diff dirty.
async function freezeMotion(page) {
  await page.evaluate(() => {
    // Metadata on a keyframe, not properties to write to the element.
    const META = new Set(["offset", "computedOffset", "composite", "easing"]);
    for (const a of document.getAnimations()) {
      try {
        if (a.effect?.getTiming?.().iterations !== Infinity) continue;
        const target = a.effect.target;
        const first = a.effect.getKeyframes?.()[0];

        if (target && first && first.computedOffset === 0) {
          // Read the declared start frame and write it as inline style. This
          // never consults a clock, so it cannot land near zero instead of at
          // it. That distinction is invisible on a linear animation, where a
          // few residual milliseconds move nothing perceptible, and visible on
          // an aggressive ease-out, where the curve is near vertical at t=0 and
          // the same residue is different geometry.
          a.cancel();
          for (const [k, v] of Object.entries(first)) {
            if (META.has(k)) continue;
            target.style.setProperty(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(v));
          }
        } else {
          // No usable start frame, so fall back to seeking. Cancelling matters
          // either way: a CSS-declared animation is owned by the style engine,
          // which re-syncs on the next recalculation and undoes a bare pause.
          a.currentTime = 0;
          a.commitStyles();
          a.cancel();
        }
      } catch {}
    }
  });
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

// Shared by both viewports. A missing section is warned about once, on the
// desktop pass, so a stale id does not print the same line twice per route.
async function sectionCrops(page, route, prefix, warn) {
  for (const id of cfg.sections) {
    const target = page.locator(`#${id}`);
    if ((await target.count()) === 0) {
      if (warn) console.warn(`warning: section #${id} not found on ${route.path}, skipping crop`);
      continue;
    }
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(cfg.timing.sectionSettle);
    await sectionShot(target, page, shot(route, `${prefix}-${id}`));
  }
}

// Crops used to shoot straight through whatever fixed chrome happened to sit
// over the element, so a dock or a scrim landed in the middle of the frame and
// read as a fault in the section.
async function sectionShot(target, page, name) {
  const hidden = await setFixedDisplay(page, cfg.hideOnSection, "none");
  if (cfg.hideOnSection.length && hidden === 0) {
    console.warn(
      `warning: hideOnSection matched nothing (${cfg.hideOnSection.join(", ")}). ` +
        `Fixed elements may sit over ${name}.jpg.`
    );
  }
  await target.screenshot(jpg(name));
  await setFixedDisplay(page, cfg.hideOnSection, "");
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
    await sectionCrops(page, route, `desktop-${primary}`, true);
    await context.close();
  }

  // 2. Mobile, primary theme: full page and the same section crops as desktop.
  //    A layout breaks at the narrow viewport first, and mobile had only ever
  //    been captured whole, which is the size at which a broken section is
  //    least visible.
  {
    const { context, page } = await newPage(browser, {
      ...cfg.viewports.mobile,
      theme: primary,
      route,
    });
    await fullPageShot(page, shot(route, `mobile-${primary}-full`));
    await sectionCrops(page, route, `mobile-${primary}`, false);
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

  // 4. Reduced motion, both viewports: content must land in its final state
  //    with no animation. Captured only. Nothing asserts it, a human still
  //    compares. This is the shot that catches a reveal leaving whole sections
  //    at opacity 0, so it is worth having at the viewport where the reveals
  //    differ. See REPORT.md.
  for (const [name, viewport] of [
    ["desktop", cfg.viewports.desktop],
    ["mobile", cfg.viewports.mobile],
  ]) {
    const { context, page } = await newPage(browser, {
      ...viewport,
      theme: primary,
      route,
      reduce: true,
    });
    await fullPageShot(page, shot(route, `${name}-${primary}-reduced-motion`));
    await context.close();
  }
}

await browser.close();
stopServer();
record(scratch ? "scratch" : "full");
console.log(`done: ${outDir}`);
process.exit(0);
