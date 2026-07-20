/**
 * ORE Exam Auto-Booker - MyGDC Portal
 * =====================================
 * Three-phase strategy:
 *
 *  Phase 1  — Keep-alive (now → 14:28)
 *             Full page reload every 30 s to keep session warm.
 *
 *  Phase 2  — Pre-warm (14:28 → 14:29:45)
 *             Full reload every 8 s. Renders the grid fresh so all portal
 *             JS is primed and the CSRF token is hot.
 *
 *  Phase 3  — Rapid snipe (14:29:50 → booked)
 *             Every 3 s we fire the portal's OWN grid-refresh event
 *             ($('.entity-grid').trigger('refresh')). This re-fetches only
 *             the grid data (~400 ms round-trip vs 3-5 s for a full reload)
 *             without re-parsing any JS/CSS. The instant a <a>Book</a> link
 *             appears in the DOM we click it, then auto-confirm on the
 *             booking page.
 *
 * Usage:
 *   node ore-autobook.js
 *
 * Requirements:
 *   npm install playwright
 *   npx playwright install chromium
 */

const { chromium } = require('playwright');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
  email:    '',
  password: '',            // ← fill in before running

  // Booking window opens on this date at 14:30 London BST (UTC+1)
  bookingOpenDate:   '2026-07-21',           // YYYY-MM-DD  ← UPDATE THIS for each booking window
  bookingOpenHour:   14,
  bookingOpenMinute: 30,

  // Target exam filters (matched case-insensitively against the grid)
  // Venue column shows the exam centre name e.g. "UCL Consultants Ltd" — NOT
  // "London". Leave blank: the portal waiting-list logic already restricts
  // what you see to exams you are eligible for.
  targetVenueFragment: '',                   // '' = book the first available slot

  // ── Timing ────────────────────────────────────────────────────────────────
  // Phase 1: keep-alive refresh interval (ms)
  keepAliveIntervalMs:  30_000,              // every 30 s

  // Phase 2: pre-warm starts this many seconds before open
  preWarmLeadSec:       120,                 // 14:28:00  → full reload every 8 s
  preWarmIntervalMs:    8_000,

  // Phase 3: rapid snipe starts this many seconds before open
  snipeLeadSec:         10,                  // 14:29:50  → grid-refresh every 3 s
  snipeIntervalMs:      3_000,               // 3 s between snipe attempts
  snipeMaxAttempts:     300,                 // 300 × 3 s = 15 min max

  // After grid 'loaded' fires, portal JS makes 2 sequential AJAX calls before
  // injecting the Book button (~895 ms total). We poll every 100 ms until it
  // appears, but stop after 1800 ms so the next snipe isn't blocked.
  gridPollIntervalMs:   100,                 // how often to check DOM after loaded
  gridPollMaxMs:        8000,                // stop scanning after 8 s per refresh (handles 8x server overload)

  // Fire the FIRST snipe this many ms BEFORE 14:30:00 so the AJAX chain
  // lands right AT 14:30:00. Real portal AJAX measured at ~2000ms round-trip
  // (entity-grid-data.json ~1500ms + waitingList ~260ms + bookings ~235ms).
  // We fire 2200ms early so applyExamLogic runs right as 14:30:00 hits.
  preFireMs:            1500,                // fire first snipe at 14:29:58.500

  // ── Test mode ─────────────────────────────────────────────────────────────
  // Set testMode: true to run a full end-to-end test RIGHT NOW.
  // Booking open time becomes testOffsetMinutes from script start so you can
  // watch keep-alive → pre-warm → snipe in real time.
  // MUST be false on the actual day (July 14).
  testMode:             false,
  testOffsetMinutes:    2,                   // open 2 min from now when testing

  // ── Mock mode ─────────────────────────────────────────────────────────────
  // Set mockMode: true to test against the local mock-portal.js server.
  // Run "node mock-portal.js" in a separate terminal first.
  // Works with testMode: true (3 min countdown) so you see the full flow.
  mockMode:             false,
  mockPort:             3000,
};
// ──────────────────────────────────────────────────────────────────────────────

const BASE_URL = CONFIG.mockMode
  ? `http://localhost:${CONFIG.mockPort}`
  : 'https://mygdc.gdc-uk.org';

/** Simple sleep with optional random jitter */
const sleep = (ms, jitter = 0) =>
  new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * jitter)));

/** Milliseconds until a target Date */
const msUntil = (target) => target.getTime() - Date.now();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildBookingOpenTime() {
  if (CONFIG.testMode) {
    const t = new Date(Date.now() + CONFIG.testOffsetMinutes * 60_000);
    console.log(`[${ts()}] ⚠️  TEST MODE — booking open time set to ${CONFIG.testOffsetMinutes} min from now: ${t.toLocaleTimeString('en-GB')}`);
    return t;
  }
  const [y, m, d] = CONFIG.bookingOpenDate.split('-').map(Number);
  return new Date(y, m - 1, d, CONFIG.bookingOpenHour, CONFIG.bookingOpenMinute, 0, 0);
}

const ts = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' +
         String(d.getMinutes()).padStart(2,'0') + ':' +
         String(d.getSeconds()).padStart(2,'0') + '.' +
         String(d.getMilliseconds()).padStart(3,'0');
};

// ─── LOGIN ─────────────────────────────────────────────────────────────────────

async function login(page) {
  console.log(`[${ts()}][login] Navigating to portal...`);
  await page.goto('https://mygdc.gdc-uk.org/', { waitUntil: 'domcontentloaded' });
  await sleep(2000, 500);

  // Dismiss cookie banner if present
  try { await page.getByRole('button', { name: /allow cookies/i }).click({ timeout: 3000 }); } catch (_) {}
  await sleep(600, 200);

  // mygdc.gdc-uk.org immediately redirects to CIAM — no need for egdc detour
  // Wait for the email field (name="username", type="text" — NOT type="email")
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  await sleep(900, 200);
  await page.fill('input[name="username"]', CONFIG.email);
  await sleep(1200, 300);
  await page.click('#usernamePrimaryButton');
  await sleep(1800, 400);

  // Password page
  await page.waitForSelector('#i0118', { timeout: 10000 });
  await sleep(700, 200);
  await page.fill('#i0118', CONFIG.password);
  await sleep(1200, 300);
  await page.click('#idSIButton9');  // Sign in
  await sleep(2500, 500);

  // "Stay signed in?" → Yes (same button ID on next screen)
  try { await page.click('#idSIButton9', { timeout: 3000 }); await sleep(1500, 300); } catch (_) {}

  await page.waitForURL('**/mygdc.gdc-uk.org/**', { timeout: 20000 });
  console.log(`[${ts()}][login] Logged in ✓  (${page.url()})`);
  return page;
}

// ─── GRID FAST-REFRESH (no full page reload) ──────────────────────────────────

/**
 * Triggers the portal's own entity-grid 'refresh' event via jQuery.
 * This re-fetches only the grid data (~400 ms) without reloading any JS/CSS.
 *
 * The Book link is ALWAYS inside the grid table — the portal JS injects it
 * into <td class="action-cell"> after two async AJAX calls complete. We poll
 * the DOM every 100 ms from the moment 'loaded' fires so we catch it the
 * instant it appears rather than waiting a fixed delay.
 *
 * Returns the full href of the "Book" link, or null.
 */
async function triggerGridRefreshAndCheckBookButton(page, venueFilter) {
  return page.evaluate(({ venueFilter, pollMs, maxMs }) => {
    return new Promise((resolve) => {
      if (typeof $ === 'undefined') return resolve({ href: null, ajaxMs: 0 });

      const $grid = $('#schedulelist .entity-grid');
      if (!$grid.length) return resolve({ href: null, ajaxMs: 0 });

      // ── Helper: scan the DOM right now for a visible Book link ───────────
      const findBookLink = () => {
        let found = null;

        // Primary: action-cell td — exact text 'Book' or 'Book Now' (confirmed from portal).
        // Do NOT use startsWith — 'Booked' also starts with 'book' and must not be clicked.
        const BOOK_LABELS = ['Book', 'Book Now'];
        $('td.action-cell a').each(function () {
          if (found) return false;
          const $a   = $(this);
          const href = ($a.attr('href') || '').trim();
          const txt  = $a.text().trim();
          if (!BOOK_LABELS.includes(txt)) return;    // exact match only
          if (!href) return;                         // must have an href
          if (venueFilter) {
            const venue = $a.closest('tr').find('td').eq(1).text().trim().toLowerCase();
            if (!venue.includes(venueFilter.toLowerCase())) return;
          }
          found = href.startsWith('http') ? href : 'https://mygdc.gdc-uk.org' + href;
        });

        return found;
      };

      let pollTimer        = null;
      let safetyTimer      = null;
      let applyExitTimer   = null;
      let observer         = null;  // MutationObserver for instant detection

      // Tracking whether tbody went empty then came back
      // (signals the grid AJAX completed and applyExamLogic is now running)
      let tbodyWentEmpty   = false;
      let populatedAt      = null;
      let triggerTime      = null;  // set just before trigger('refresh'), used to measure AJAX latency

      const finish = (href, source) => {
        clearInterval(pollTimer);
        clearTimeout(safetyTimer);
        clearTimeout(applyExitTimer);
        try { if (observer) observer.disconnect(); } catch(_) {}
        // ajaxMs = time from trigger('refresh') to tbody repopulating.
        // Returned to Node.js so the snipe loop can adapt the next-retry
        // interval to actual server load.
        const ajaxMs = (populatedAt && triggerTime) ? populatedAt - triggerTime : 0;
        resolve({ href, ajaxMs, detectedBy: source || 'unknown' });
      };

      // MutationObserver: fires within 1-2ms of any DOM change under #schedulelist.
      // The Book button is injected by applyExamLogic as a new <a> node inside the
      // grid tbody — the observer catches it the instant it's written to the DOM,
      // eliminating the up-to-100ms gap of the setInterval poll.
      try {
        observer = new MutationObserver(() => {
          // Fix visibility whenever DOM changes under the grid
          const g = document.querySelector('#schedulelist .entity-grid');
          if (g && g.style.visibility === 'hidden' &&
              document.querySelectorAll('#schedulelist .entity-grid tbody tr').length > 0) {
            g.style.visibility = 'visible';
          }
          const href = findBookLink();
          if (href) finish(href, 'MutationObserver');
        });
        observer.observe(
          document.querySelector('#schedulelist') || document.body,
          { childList: true, subtree: true, attributes: false }
        );
      } catch(_) {
        observer = null;  // browser doesn't support it — setInterval takes over
      }

      // AJAX chain timing:
      //   T=0       trigger('refresh') → tbody cleared immediately
      //   T=~500ms  grid AJAX returns → tbody repopulated → 'loaded' fires
      //   T=~800ms  applyExamLogic's 2 extra APIs return → Book button injected
      //             — DOM is now frozen for this cycle —
      //
      // Smart exit: once we detect tbody repopulated (step 2), we start a
      // 1200ms countdown for applyExamLogic to finish (step 3).  If the Book
      // button hasn't appeared by then it won't appear this cycle — return null
      // and retry immediately rather than spinning for the full 8s safety window.
      //
      // Also force visibility:visible on every tick (portal's revealExamOnce() only
      // fires once per page load, so repeated refresh leaves the grid hidden).
      // setInterval: backup poller + handles visibility fix + tracks tbody state
      // for smart exit. MutationObserver handles the instant detection above.
      pollTimer = setInterval(() => {
        const g        = document.querySelector('#schedulelist .entity-grid');
        const rows     = document.querySelectorAll('#schedulelist .entity-grid tbody tr').length;
        // realRows = rows that have real data columns (not the loading placeholder).
        // The loading placeholder is: <tr><td colspan="6">Loading...</td></tr>
        // Real exam rows have multiple <td> cells with no colspan attribute.
        // We CANNOT use td.action-cell here because that only exists after
        // applyExamLogic runs at 14:30 — before that it's always 0, breaking timing.
        const realRows = document.querySelectorAll(
          '#schedulelist .entity-grid tbody td:not([colspan])'
        ).length;

        // Restore visibility so the user can see the table (any row, including loading row)
        if (g && g.style.visibility === 'hidden' && rows > 0) {
          g.style.visibility = 'visible';
        }

        // Check for Book button immediately on every tick
        const href = findBookLink();
        if (href) return finish(href, 'setInterval');

        // Track tbody state using realRows so the loading placeholder doesn't count as
        // 'populated' — only real grid data rows (with td.action-cell) trigger populatedAt.
        // This is what was causing ajaxMs=0: the loading row kept rows>0 the whole time.
        if (!realRows) {
          tbodyWentEmpty = true;  // AJAX in-flight: real data not yet returned
        } else if (tbodyWentEmpty && !populatedAt) {
          // Real exam rows repopulated → grid AJAX done, applyExamLogic now running
          populatedAt = Date.now();
          // Give applyExamLogic 1200ms to call its 2 APIs and inject Book button
          applyExitTimer = setTimeout(() => finish(findBookLink(), 'applyExitTimer'), 1200);
        }
      }, pollMs);

      // Hard safety timeout — fires if AJAX never completes (server hung)
      safetyTimer = setTimeout(() => finish(findBookLink(), 'safetyTimer'), maxMs);

      triggerTime = Date.now();
      $grid.trigger('refresh');
    });
  }, {
    venueFilter: venueFilter || '',
    pollMs:  CONFIG.gridPollIntervalMs,
    maxMs:   CONFIG.gridPollMaxMs,
  });
}

// ─── FULL PAGE RELOAD FALLBACK ────────────────────────────────────────────────

async function reloadAndCheckBookButton(page, venueFilter, examsUrl) {
  const targetUrl = examsUrl || `${BASE_URL}/exams/`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait for the portal spinner to clear (up to 12 s)
  await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 12000 }).catch(() => {});
  await sleep(500);

  const href = await page.evaluate((vf) => {
    let found = null;
    document.querySelectorAll('td.action-cell a').forEach(a => {
      if (found) return;
      const href = (a.getAttribute('href') || '').trim();
      if (!['Book', 'Book Now'].includes(a.textContent.trim())) return;  // exact match only
      if (!href) return;
      if (vf) {
        const row = a.closest('tr');
        if (!row) return;
        const cells = row.querySelectorAll('td');
        const venue = cells[1] ? cells[1].textContent.trim().toLowerCase() : '';
        if (!venue.includes(vf.toLowerCase())) return;
      }
      found = href.startsWith('http') ? href : 'https://mygdc.gdc-uk.org' + href;
    });
    return found;
  }, venueFilter || '');

  return href || null;
}

// ─── BOOK THE EXAM ─────────────────────────────────────────────────────────────

async function confirmBooking(page, bookingHref) {
  console.log('');
  console.log(`[${ts()}] ██████████████████████████████████████████████████`);
  console.log(`[${ts()}] █                                                █`);
  console.log(`[${ts()}] █   🎯  BOOK BUTTON FOUND — NAVIGATING NOW  🎯   █`);
  console.log(`[${ts()}] █                                                █`);
  console.log(`[${ts()}] ██████████████████████████████████████████████████`);
  console.log('');

  console.log(`[${ts()}][book] → ${bookingHref}`);
  // Click the Book element immediately — minimum latency.
  // Screenshot taken concurrently while navigation loads (doesn't delay click).
  const clicked = await page.evaluate((href) => {
    const a = Array.from(document.querySelectorAll('td.action-cell a'))
      .find(el => ['Book', 'Book Now'].includes(el.textContent.trim()) && (el.getAttribute('href') || '').trim());
    if (a) { a.click(); return true; }
    return false;
  }, bookingHref).catch(() => false);

  if (clicked) {
    console.log(`[${ts()}][book] Clicked Book element directly ✓`);
    // Start waiting for navigation, take screenshot in parallel while page loads
    const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.screenshot({ path: 'book-button-found.png', fullPage: false }).catch(() => {});
    console.log(`[${ts()}][book] 📸 Screenshot saved → book-button-found.png`);
    await navPromise;
  } else {
    console.log(`[${ts()}][book] Element gone — navigating via href directly`);
    await page.goto(bookingHref, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: 'book-button-found.png', fullPage: false }).catch(() => {});
  }
  console.log('');
  console.log(`[${ts()}] ████████████████████████████████████████████████████████`);
  console.log(`[${ts()}] █                                                      █`);
  console.log(`[${ts()}] █   ✅  BOOKING PAGE LOADED — COMPLETE THE FORM NOW!  █`);
  console.log(`[${ts()}] █   Fill in all fields and click Confirm/Submit ASAP   █`);
  console.log(`[${ts()}] █                                                      █`);
  console.log(`[${ts()}] ████████████████████████████████████████████████████████`);
  console.log('');
  return true;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const openTime    = buildBookingOpenTime();
  const preWarmTime = new Date(openTime.getTime() - CONFIG.preWarmLeadSec  * 1000);
  const snipeTime   = new Date(openTime.getTime() - CONFIG.snipeLeadSec    * 1000);

  // ── Startup warnings ─────────────────────────────────────────────────────
  if (CONFIG.testMode) {
    console.log('');
    console.log(`[${ts()}] ‼️  ‼️  ‼️  WARNING: testMode is TRUE  ‼️  ‼️  ‼️`);
    console.log(`[${ts()}] ‼️  Booking time = NOW + ${CONFIG.testOffsetMinutes} min  (NOT July 14 14:30)`);
    console.log(`[${ts()}] ‼️  SET testMode: false BEFORE RUNNING ON JULY 14  ‼️`);
    console.log('');
  }
  if (CONFIG.mockMode) {
    console.log(`[${ts()}] 🧪 MOCK MODE — targeting http://localhost:${CONFIG.mockPort}`);
    console.log(`[${ts()}] 🧪 Make sure "node mock-portal.js" is running in another terminal.`);
  }

  console.log(`[${ts()}] Booking opens : ${openTime.toLocaleString('en-GB')}`);
  console.log(`[${ts()}] Pre-warm start: ${preWarmTime.toLocaleTimeString('en-GB')} (full reload every ${CONFIG.preWarmIntervalMs/1000}s)`);
  console.log(`[${ts()}] Snipe start   : ${snipeTime.toLocaleTimeString('en-GB')} (grid-refresh every ${CONFIG.snipeIntervalMs/1000}s)`);

  // Try real Google Chrome first; fall back to Playwright Chromium
  let browser;
  try {
    browser = await chromium.launch({
      channel:  'chrome',          // uses your installed Google Chrome
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    console.log(`[${ts()}] Launched Google Chrome ✓`);
  } catch (_) {
    browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    console.log(`[${ts()}] Launched Playwright Chromium (Chrome not found)`);
  }

  const context = await browser.newContext({
    locale:     'en-GB',
    timezoneId: 'Europe/London',
    viewport:   { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // ── STEP 1: Login / navigate to exams page ─────────────────────────────
  // In mockMode: navigate straight to mock server (no login needed).
  // In real mode: navigate to portal; wait for manual login + MFA if needed.
  const examsUrl = CONFIG.mockMode
    ? `${BASE_URL}/exams/?opensAt=${openTime.getTime()}`
    : `${BASE_URL}/exams/`;

  await page.goto(examsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (!CONFIG.mockMode && !page.url().includes('mygdc.gdc-uk.org/exams')) {
    console.log(``);
    console.log(`[${ts()}] ⚠️  NOT LOGGED IN — please log in manually in the browser window.`);
    console.log(`[${ts()}]    1. Enter your email and password`);
    console.log(`[${ts()}]    2. Complete any MFA / email verification code`);
    console.log(`[${ts()}]    3. Script continues automatically once you reach the exams page.`);
    console.log(``);
    try {
      await page.waitForURL(`**mygdc.gdc-uk.org/exams**`, { timeout: 300_000 });
    } catch (_) {
      if (!page.url().includes('mygdc.gdc-uk.org/exams')) {
        console.log(`[${ts()}] ⚠️  Still not on exams page — check the browser window.`);
        await page.waitForURL(`**mygdc.gdc-uk.org/exams**`, { timeout: 300_000 });
      }
    }
  }

  await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 15000 }).catch(() => {});
  console.log(`[${ts()}] ✅ On exams page. Waiting for pre-warm phase...`);
  if (!CONFIG.mockMode) {
    console.log(`[${ts()}] ⚡ IMPORTANT: Keep this laptop plugged in and screen/sleep disabled until after 14:30 tomorrow.`);
  }

  // ── Clock accuracy check (real mode only) ────────────────────────────────
  if (!CONFIG.mockMode) {
    const clockDrift = await page.evaluate(async () => {
      try {
        const r = await fetch('https://mygdc.gdc-uk.org/', { method: 'HEAD', cache: 'no-cache' });
        const serverTime = new Date(r.headers.get('date') || '').getTime();
        return isNaN(serverTime) ? null : Date.now() - serverTime;
      } catch(_) { return null; }
    }).catch(() => null);
    if (clockDrift !== null) {
      const driftSec = (clockDrift / 1000).toFixed(1);
      if (Math.abs(clockDrift) > 2000) {
        process.stdout.write('\x07\x07');
        console.log(`[${ts()}] ⚠️  CLOCK DRIFT: your clock is ${driftSec}s ${clockDrift > 0 ? 'AHEAD of' : 'BEHIND'} the server!`);
        console.log(`[${ts()}] ⚠️  Go to: Settings → Time & Language → Sync now — then restart this script.`);
      } else {
        console.log(`[${ts()}] ✅ Clock check: ${driftSec}s drift from server (OK)`);
      }
    }
  }

  // ── STEP 2: Keep-alive – alternating full reload / grid refresh every 30 s ──
  // Odd  cycles: full page reload  → keeps session alive, re-binds jQuery/CSRF
  // Even cycles: grid refresh only → cheaper on server, still keeps page warm
  // Session expiry always forces a full reload regardless of cycle.
  let kaCounter = 0;
  let kaFullReload = true;  // start with a full reload
  while (true) {
    const waitMs = Math.min(CONFIG.keepAliveIntervalMs, msUntil(preWarmTime) - 5000);
    if (waitMs <= 0) break;
    await sleep(waitMs);
    if (msUntil(preWarmTime) <= 0) break;

    kaCounter++;
    const minsLeft = Math.ceil(msUntil(preWarmTime) / 60_000);
    const onExamsPage = CONFIG.mockMode || page.url().includes('mygdc.gdc-uk.org/exams');

    if (kaFullReload || !onExamsPage) {
      // ── Full reload cycle (or forced reload due to session expiry) ──────
      console.log(`[${ts()}] [keep-alive #${kaCounter}] Full reload (~${minsLeft}m to pre-warm)...`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 10000 }).catch(() => {});

      // ── Session expiry check (real mode only) ──────────────────────────
      if (!CONFIG.mockMode && !page.url().includes('mygdc.gdc-uk.org/exams')) {
        process.stdout.write('\x07\x07\x07');
        console.log('');
        console.log(`[${ts()}] 🚨🚨🚨 SESSION EXPIRED — redirected to: ${page.url()}`);
        console.log(`[${ts()}] 🚨  LOG IN AGAIN IN THE BROWSER WINDOW NOW.`);
        console.log(`[${ts()}] 🚨  Script will auto-resume once you reach the exams page.`);
        console.log('');
        await page.waitForURL('**mygdc.gdc-uk.org/exams**', { timeout: 1_800_000 })
          .catch(() => {});
        await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 15000 }).catch(() => {});
        console.log(`[${ts()}] ✅ Re-logged in. Keep-alive resuming...`);
        kaFullReload = true;  // force full reload again next cycle after re-login
        continue;
      } else {
        console.log(`[${ts()}] [keep-alive #${kaCounter}] Full reload ✓ (~${minsLeft}m to pre-warm)`);
      }
    } else {
      // ── Grid refresh cycle ─────────────────────────────────────────────
      console.log(`[${ts()}] [keep-alive #${kaCounter}] Grid refresh (~${minsLeft}m to pre-warm)...`);
      await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 5000 }).catch(() => {});
      const kaProbe = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment)
        .catch(() => ({ href: null, ajaxMs: 0 }));
      console.log(`[${ts()}] [keep-alive #${kaCounter}] Grid refresh ✓ (AJAX: ${kaProbe.ajaxMs}ms, ~${minsLeft}m to pre-warm)`);
      if (kaProbe.href) {
        console.log(`[${ts()}] [keep-alive #${kaCounter}] 📡 Book button detected by: ${kaProbe.detectedBy}`);
        console.log(`[${ts()}] [keep-alive #${kaCounter}] ⚡ BOOK BUTTON VISIBLE — skipping to pre-warm immediately!`);
        break;
      }
    }

    kaFullReload = !kaFullReload;  // toggle: reload → refresh → reload → ...
  }

  // gridRefreshSamples: circular buffer of last 3 grid-refresh-only chain timings.
  // We average them for preFireMs — more stable than max (a single spike no longer
  // dominates), and more recent than a global max (decays after a burst of slow cycles).
  const gridRefreshSamples = [];  // max length 3, FIFO

  // Wait for the exact pre-warm start time
  if (msUntil(preWarmTime) > 0) await sleep(msUntil(preWarmTime));

  // ── STEP 3: Pre-warm – alternating full reload / grid refresh every 8 s ──
  // Odd  cycles: full page reload  → re-binds jQuery, refreshes CSRF token
  // Even cycles: grid refresh only → measures AJAX chain, cheaper on server
  // Both cycles: probe for early Book button + measure AJAX chain timing
  console.log(`[${ts()}] ── PRE-WARM phase (alternating full reload / grid refresh every ${CONFIG.preWarmIntervalMs/1000}s) ──`);
  let preWarmFullReload = true;  // start with a full reload
  while (msUntil(snipeTime) > 0) {
    if (preWarmFullReload) {
      console.log(`[${ts()}] [pre-warm] Full page reload (${Math.round(msUntil(openTime)/1000)}s until open)...`);
      await page.goto(examsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      // Wait for jQuery + grid to initialise after the full reload
      await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 8000 }).catch(() => {});
    } else {
      console.log(`[${ts()}] [pre-warm] Grid refresh only (${Math.round(msUntil(openTime)/1000)}s until open)...`);
      // Ensure jQuery is still bound before firing the grid refresh
      await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 5000 }).catch(() => {});
    }

    // Every cycle: probe the grid (measures 3-AJAX chain + checks for early Book button)
    //   AJAX #1  entity-grid-data.json  → tbody repopulated  (= ajaxMs)
    //   AJAX #2  /_api/gdc_waitinglists  → inside applyExamLogic
    //   AJAX #3  /_api/new_exambookings  → inside applyExamLogic
    const probe = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment);
    if (probe.ajaxMs > 0) {
      const chainMs = probe.ajaxMs + 1200;  // AJAX #1 measured + #2+#3 budget
      // Only update measuredChainMs from grid-refresh cycles (preWarmFullReload=false).
      // Full page reload includes page-parse time and inflates the chain estimate,
      // causing the snipe trigger to fire too early (chain completes before 14:30).
      if (!preWarmFullReload) {
        gridRefreshSamples.push(chainMs);
        if (gridRefreshSamples.length > 3) gridRefreshSamples.shift();  // keep last 3
        const avg = Math.round(gridRefreshSamples.reduce((a, b) => a + b, 0) / gridRefreshSamples.length);
        console.log(`[${ts()}] [pre-warm] 3-AJAX chain ~${chainMs}ms (grid refresh) → samples=[${gridRefreshSamples.join(',')}] avg=${avg}ms`);
      } else {
        console.log(`[${ts()}] [pre-warm] 3-AJAX chain ~${chainMs}ms (full reload — excluded from calibration)`);
      }
    } else {
      console.log(`[${ts()}] [pre-warm] AJAX timing not captured this cycle`);
    }

    if (probe.href) {
      console.log(`[${ts()}] [pre-warm] 📡 Book button detected by: ${probe.detectedBy}`);
      console.log(`[${ts()}] [pre-warm] ⚡ BOOK BUTTON ALREADY VISIBLE — jumping to snipe phase!`);
      break;
    }

    preWarmFullReload = !preWarmFullReload;  // toggle: reload → refresh → reload → ...
    const wait = Math.min(CONFIG.preWarmIntervalMs, msUntil(snipeTime));
    if (wait > 500) await sleep(wait);
  }

  // Final reload to ensure page + jQuery are fully initialised before snipe.
  // Skip if we're already within 12s of firstFireTime (reload takes ~3-8s and
  // would push us past the fire time — page is already primed from pre-warm).
  const timeToSnipe = msUntil(snipeTime);
  if (timeToSnipe > 12000) {
    console.log(`[${ts()}] Final pre-snipe full reload (${Math.round(timeToSnipe/1000)}s to snipe)...`);
    await page.goto(examsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 10000 }).catch(() => {});
  } else {
    console.log(`[${ts()}] Skipping final reload — only ${Math.round(timeToSnipe/1000)}s to snipe (page already primed)`);
  }

  // Final pre-snipe probe: one more grid refresh right before the snipe phase.
  // Skip if we're already within 10s of firstFireTime (probe takes up to 8s).
  let booked = false;
  let fullReloadFallback = false;

  // Use estimated firstFireTime (openTime - preFireMs floor) to decide if probe fits.
  // Real firstFireTime is recalculated after measuredChainMs is updated by the probe.
  const timeToEstFirstFire = openTime.getTime() - CONFIG.preFireMs - Date.now();
  if (timeToEstFirstFire > 10000) {
    const finalProbe = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment)
      .catch(() => ({ href: null, ajaxMs: 0 }));
    if (finalProbe.ajaxMs > 0) {
      const chainMs = finalProbe.ajaxMs + 1200;
      if (chainMs > measuredChainMs) measuredChainMs = chainMs;
      console.log(`[${ts()}] ✅ AJAX chain confirmed (AJAX #1: ${finalProbe.ajaxMs}ms, full chain est. ${chainMs}ms)`);
    } else {
      // Chain didn't fire — reload one more time to re-bind handlers
      console.log(`[${ts()}] ⚠️  AJAX chain not detected — doing extra reload to re-bind JS handlers...`);
      await page.goto(examsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 10000 }).catch(() => {});
      console.log(`[${ts()}] ✅ Extra reload done — proceeding to snipe`);
    }
    if (finalProbe.href && !booked) {
      console.log(`[${ts()}] [final-probe] 📡 Book button detected by: ${finalProbe.detectedBy}`);
      console.log(`[${ts()}] [final-probe] ⚡ BOOK BUTTON VISIBLE — booking immediately!`);
      booked = await confirmBooking(page, finalProbe.href);
    }
  } else {
    console.log(`[${ts()}] Skipping final probe — only ${Math.round(timeToEstFirstFire/1000)}s to first fire (going straight to snipe)`);
  }

  // Dynamic preFireMs: fire trigger exactly measuredChainMs before 14:30:00
  // so applyExamLogic runs and checks Date.now() AT 14:30:00 (not before it).
  //
  // NO +200ms buffer — a positive buffer means the chain completes BEFORE
  // 14:30:00, applyExamLogic finds Date.now() < bookingStart, injects nothing,
  // and we waste the entire first snipe cycle.
  //
  // Variability is handled by the smart re-fire in the snipe loop:
  //   if chain was slightly faster (completed at 14:29:59.9) → snipe returns null
  //   → sleep only until openTime+100ms → snipe #2 fires 100ms after open
  //   if chain was slightly slower (completed at 14:30:00.1) → button injected ✔
  //
  // Timeline (example: measuredChainMs=1700ms):
  //   14:29:58.300  trigger sent — AJAX #1 (grid-data) starts
  //   14:29:58.800  AJAX #1 returns (ajaxMs~500ms) — AJAXes #2+#3 start
  //   14:30:00.000  AJAXes #2+#3 return — applyExamLogic: Date.now() ≥ 14:30:00 ✔
  //   14:30:00.000  Book button injected into DOM
  //   14:30:00.100  100ms poller catches it → navigate to booking page
  //
  const measuredAvgMs = gridRefreshSamples.length > 0
    ? Math.round(gridRefreshSamples.reduce((a, b) => a + b, 0) / gridRefreshSamples.length)
    : 0;
  const dynamicPreFireMs = measuredAvgMs > 0
    ? Math.min(5000, Math.max(CONFIG.preFireMs, measuredAvgMs))
    : CONFIG.preFireMs;
  console.log(`[${ts()}] ⏱  preFireMs: ${dynamicPreFireMs}ms (last-3-avg: ${measuredAvgMs || 'n/a'}ms, samples=[${gridRefreshSamples.join(',')}], config fallback: ${CONFIG.preFireMs}ms)`);
  const firstFireTime = new Date(openTime.getTime() - dynamicPreFireMs);
  // Light grid refreshes every 3s until 9s before firstFireTime.
  // Exit with enough headroom for one full reload + one grid refresh below.
  while (!booked && msUntil(firstFireTime) > 9000) {
    const gap = msUntil(firstFireTime);
    console.log(`[${ts()}] [pre-fire wait] ${(gap/1000).toFixed(1)}s to go — keeping grid warm...`);
    await page.evaluate(() => {
      try { if (typeof $ !== 'undefined') $('#schedulelist .entity-grid').trigger('refresh'); } catch(_) {}
    }).catch(() => {});
    await sleep(Math.min(3000, msUntil(firstFireTime) - 9000));
  }

  // One full page reload + one grid refresh right before the snipe window.
  // Only runs if there is enough headroom (>9s to firstFireTime) — a full
  // goto() takes ~3-4s and the probe ~2s, so 9s is the minimum safe buffer.
  // With snipeLeadSec=10 and typical dynamicPreFireMs 1500-2500ms this block
  // is usually skipped (only ~3-7s remain at this point) and we go straight
  // to the wait. It kicks in when dynamicPreFireMs is large (slow server day).
  if (!booked && msUntil(firstFireTime) > 9000) {
    console.log(`[${ts()}] [pre-snipe] Final page reload + grid refresh (~${Math.round(msUntil(firstFireTime)/1000)}s to first snipe trigger)...`);
    await page.goto(examsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 8000 }).catch(() => {});
    const preSnipeWarm = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment)
      .catch(() => ({ href: null, ajaxMs: 0 }));
    if (preSnipeWarm.ajaxMs > 0) {
      const chainMs = preSnipeWarm.ajaxMs + 1200;
      if (chainMs > measuredChainMs) measuredChainMs = chainMs;
      console.log(`[${ts()}] [pre-snipe] AJAX chain ~${chainMs}ms → updated measuredChainMs: ${measuredChainMs}ms`);
    }
    if (preSnipeWarm.href) {
      console.log(`[${ts()}] [pre-snipe] 📡 Book button detected by: ${preSnipeWarm.detectedBy}`);
      console.log(`[${ts()}] [pre-snipe] ⚡ BOOK BUTTON FOUND — booking immediately, no further refreshes!`);
      booked = await confirmBooking(page, preSnipeWarm.href);
    }
  } else {
    console.log(`[${ts()}] [pre-snipe] Skipping extra reload — only ${Math.round(msUntil(firstFireTime)/1000)}s to first snipe (page already primed from finalProbe)`);
  }

  // Wait remaining time until the exact first-fire moment (skipped if already booked)
  if (!booked && msUntil(firstFireTime) > 0) await sleep(msUntil(firstFireTime));

  // ── STEP 4: RAPID SNIPE ───────────────────────────────────────────────────
  if (!booked) console.log(`[${ts()}] ══ SNIPE START — firing ${dynamicPreFireMs}ms before open (last-3-avg: ${measuredAvgMs || 'n/a'}ms) ══`);

  for (let i = 1; !booked && i <= CONFIG.snipeMaxAttempts; i++) {
    const t0 = Date.now();
    console.log(`[${ts()}] [snipe #${i}] firing grid refresh...`);

    let lastAjaxMs = 0;

    try {
      let bookHref = null;

      if (!fullReloadFallback) {
        // Grid refresh is sufficient — applyExamLogic fires after trigger('refresh')
        // exactly the same as after a full page load (confirmed on real portal).
        // No full reload needed before clicking Book.
        const result = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment);
        bookHref  = result.href;
        lastAjaxMs = result.ajaxMs;
        if (lastAjaxMs) console.log(`[${ts()}] [snipe #${i}] grid AJAX took ${lastAjaxMs}ms`);
        if (result.href) console.log(`[${ts()}] [snipe #${i}] 📡 Book button detected by: ${result.detectedBy}`);
      } else {
        // Full reload fallback — one reload to re-establish page state, then
        // switch back to fast grid refresh for the next attempt.
        bookHref = await reloadAndCheckBookButton(page, CONFIG.targetVenueFragment, examsUrl);
        if (bookHref) console.log(`[${ts()}] [snipe #${i}] 📡 Book button detected by: full-page-reload`);
        fullReloadFallback = false;  // recovered — try grid refresh again next cycle
        console.log(`[${ts()}] [snipe #${i}] Full reload done — switching back to grid refresh for next cycle`);
      }

      if (bookHref) {
        console.log(`[${ts()}] [snipe #${i}] 🎯 BOOK LINK FOUND → ${bookHref}`);
        booked = await confirmBooking(page, bookHref);
        if (booked) break;
        // If confirm failed, do one full reload to recover page state
        fullReloadFallback = true;
      } else {
        console.log(`[${ts()}] [snipe #${i}] No Book button yet (${Date.now() - t0}ms)`);
      }
    } catch (err) {
      console.error(`[${ts()}] [snipe #${i}] Error: ${err.message} — switching to full-reload fallback`);
      fullReloadFallback = true;
    }

    if (!booked && i < CONFIG.snipeMaxAttempts) {
      const msToOpen  = msUntil(openTime);
      const elapsed   = Date.now() - t0;

      // Smart re-fire: within ±3s of open time, fire the next trigger IMMEDIATELY.
      // The chain itself (~1200ms at hot-cache speed) acts as the timer — it will
      // land right at/after 14:30:00. Any sleep here is pure wasted time.
      if (msToOpen > -3000 && msToOpen < CONFIG.snipeIntervalMs) {
        console.log(`[${ts()}] [snipe #${i}] near/past open — re-firing immediately (${(msToOpen/1000).toFixed(2)}s to open)`);
        // no sleep — fire right now
      } else {
        // Away from open time: use dynamic interval based on server load
        //   base 3s, extended when AJAX is slow so we don't spam an overloaded server
        //   ajaxMs=0   (no data / fallback path)  → 3000ms
        //   ajaxMs=500 (fast)                     → 3000ms
        //   ajaxMs=1000                           → 3200ms
        //   ajaxMs=2000 (moderate load)           → 4200ms
        //   ajaxMs=3000+ (heavy load)             → 5000ms (capped)
        const lastAjaxMsSafe = lastAjaxMs || 0;
        const dynamicIntervalMs = Math.min(5000, CONFIG.snipeIntervalMs + Math.max(0, lastAjaxMsSafe - 800));
        const remaining = Math.max(0, dynamicIntervalMs - elapsed);
        if (remaining > 0) console.log(`[${ts()}] [snipe #${i}] next retry in ${remaining}ms (dynamic: ${dynamicIntervalMs}ms, AJAX: ${lastAjaxMsSafe}ms)`);
        await sleep(remaining, 200);  // small jitter ±200ms
      }
    }
  }

  if (!booked) {
    console.warn(`[${ts()}] ⚠️  Did not complete booking. Check booking-page.png.`);
  }

  console.log(`[${ts()}] Script finished. Browser left open — press Ctrl+C to quit.`);
  await new Promise(() => {}); // keep browser open for manual review / payment
}

main().catch(err => {
  console.error(`[${ts()}][fatal]`, err.message);
  console.log(`[${ts()}][fatal] Script crashed but browser is kept open. Press Ctrl+C to exit.`);
  // Do NOT call process.exit — keep Chrome open so you can see the booking page
  return new Promise(() => {});
});
