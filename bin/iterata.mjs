#!/usr/bin/env node
// Capture design screenshots of a running site with Playwright.
//
// Quick mode (one shot against an already-running dev server, seconds, for
// micro-iterations):
//   iterata <label> --quick [--url http://localhost:3000]
//
// Full rig (builds, serves, captures the whole set, for checkpoints):
//   iterata <version> [--skip-build] [--port 4123]
//
// Output: <outDir>/<version>/screens/*.jpg, or <outDir>/quick/<label>.jpg
//
// Configuration comes from iterata.config.json in the working
// directory (see config.example.json). Every field has a default, so the
// tool runs against a plain Next.js app with no config at all.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  // localStorage key the theme switcher reads, so shots are deterministic.
  // next-themes uses "theme". null disables the seeding.
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
  // Milliseconds. scrollStep drives how patiently the page is scrolled so
  // every scroll-triggered reveal fires; settleAfter waits out entrance
  // animations and counters before the shutter.
  timing: { scrollStep: 250, settleAfter: 2000, afterScrollTop: 600, sectionSettle: 400 },
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
  return {
    ...DEFAULTS,
    ...raw,
    viewports: { ...DEFAULTS.viewports, ...(raw.viewports ?? {}) },
    timing: { ...DEFAULTS.timing, ...(raw.timing ?? {}) },
    _source: path,
  };
}

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (flag(name) ? args[args.indexOf(`--${name}`) + 1] : null);

const version = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--url" && args[args.indexOf(a) - 1] !== "--port" && args[args.indexOf(a) - 1] !== "--config");

if (!version) {
  console.error(
    "usage:\n" +
      "  iterata <label> --quick [--url URL]     one shot, running server\n" +
      "  iterata <version> [--skip-build] [--port N]  full rig"
  );
  process.exit(1);
}

const cwd = process.cwd();
const cfg = loadConfig(cwd);
const quick = flag("quick");
const skipBuild = flag("skip-build");
const port = Number(value("port")) || cfg.port;
const baseUrl = quick ? (value("url") ?? cfg.devUrl) : `http://localhost:${port}`;
const outDir = quick
  ? join(cfg.outDir, "quick")
  : join(cfg.outDir, version, "screens");

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
// KNOWN WEAKNESS: this is fixed-timing, not a real signal. A page with an
// animation longer than settleAfter is captured mid-flight, and a static
// page pays the full wait for nothing. See REPORT.md.
async function settle(page, timing) {
  await page.waitForLoadState("load");
  await page.evaluate(async (step) => {
    let y = 0;
    const max = document.body.scrollHeight;
    while (y < max) {
      y += 500;
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, step));
    }
  }, timing.scrollStep);
  await page.waitForTimeout(timing.settleAfter);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(timing.afterScrollTop);
}

async function newPage(browser, { width, height, theme, reduce = false }) {
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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await settle(page, cfg.timing);
  return { context, page };
}

const jpg = (name) => ({
  path: join(outDir, `${name}.jpg`),
  type: "jpeg",
  quality: cfg.jpegQuality,
});

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

if (quick) {
  const { context, page } = await newPage(browser, {
    ...cfg.viewports.desktop,
    theme: "dark",
  });
  await fullPageShot(page, version);
  await context.close();
  await browser.close();
  console.log(`done: ${join(outDir, `${version}.jpg`)}`);
  process.exit(0);
}

// 1. Desktop dark: full page, hero viewport, and one crop per configured section.
{
  const { context, page } = await newPage(browser, { ...cfg.viewports.desktop, theme: "dark" });
  await fullPageShot(page, "desktop-dark-full");
  await page.screenshot(jpg("desktop-dark-hero"));
  for (const id of cfg.sections) {
    const target = page.locator(`#${id}`);
    if ((await target.count()) === 0) {
      console.warn(`warning: section #${id} not found, skipping crop`);
      continue;
    }
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(cfg.timing.sectionSettle);
    await target.screenshot(jpg(`desktop-dark-${id}`));
  }
  await context.close();
}

// 2. Mobile dark, full page.
{
  const { context, page } = await newPage(browser, { ...cfg.viewports.mobile, theme: "dark" });
  await fullPageShot(page, "mobile-dark-full");
  await context.close();
}

// 3. Desktop light, full page.
{
  const { context, page } = await newPage(browser, { ...cfg.viewports.desktop, theme: "light" });
  await fullPageShot(page, "desktop-light-full");
  await context.close();
}

// 4. Reduced motion: content must land in its final state with no animation.
//    Captured only. Nothing asserts it, a human still compares. See REPORT.md.
{
  const { context, page } = await newPage(browser, {
    ...cfg.viewports.desktop,
    theme: "dark",
    reduce: true,
  });
  await fullPageShot(page, "desktop-dark-reduced-motion");
  await context.close();
}

await browser.close();
stopServer();
console.log(`done: ${outDir}`);
process.exit(0);
