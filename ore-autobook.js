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
 *  Phase 3  — Rapid snipe (14:29:45 → booked)
 *             Every 2 s we fire the portal's OWN grid-refresh event
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
  email:    'sheetaladdala@gmail.com',
  password: 'Vedh@2905',            // ← fill in before running

  // Booking window opens on this date at 14:30 London BST (UTC+1)
  bookingOpenDate:   '2026-07-14',           // YYYY-MM-DD
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
  snipeLeadSec:         15,                  // 14:29:45  → grid-refresh every 2 s
  snipeIntervalMs:      2_000,               // 2 s between grid refreshes
  snipeMaxAttempts:     300,                 // 300 × 2 s = 10 min max

  // After grid 'loaded' fires, portal JS makes 2 sequential AJAX calls before
  // injecting the Book button (~895 ms total). We poll every 100 ms until it
  // appears, but stop after 1800 ms so the next snipe isn't blocked.
  gridPollIntervalMs:   100,                 // how often to check DOM after loaded
  gridPollMaxMs:        8000,                // stop scanning after 8 s per refresh (handles 8x server overload)

  // Fire the FIRST snipe this many ms BEFORE 14:30:00 so the AJAX chain
  // (400ms grid + 260ms waitingList + 235ms bookings = ~895ms) lands right AT
  // 14:30:00. With <1ms ping this means Book button appears at ~14:30:00.005.
  preFireMs:            900,                 // fire first snipe at 14:29:59.100

  // ── Test mode ─────────────────────────────────────────────────────────────
  // Set testMode: true to run a full end-to-end test RIGHT NOW.
  // Booking open time becomes testOffsetMinutes from script start so you can
  // watch keep-alive → pre-warm → snipe in real time.
  // MUST be false on the actual day (July 14).
  testMode:             true,
  testOffsetMinutes:    3,                   // open 3 min from now when testing
};
// ──────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://mygdc.gdc-uk.org';

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

const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 1 });

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
      if (typeof $ === 'undefined') return resolve(null);

      const $grid = $('#schedulelist .entity-grid');
      if (!$grid.length) return resolve(null);

      // ── Helper: scan the DOM right now for a visible Book link ───────────
      const findBookLink = () => {
        let found = null;

        // Primary: action-cell td (exactly where the portal injects the link)
        $('td.action-cell a').each(function () {
          if (found) return false;
          const $a   = $(this);
          const href = $a.attr('href') || '';
          if (!href.includes('booking-ore-exam')) return;
          if ($a.text().trim() !== 'Book') return;  // exact case, no padding
          if (venueFilter) {
            const venue = $a.closest('tr').find('td').eq(1).text().trim().toLowerCase();
            if (!venue.includes(venueFilter.toLowerCase())) return;
          }
          found = href.startsWith('http') ? href : 'https://mygdc.gdc-uk.org' + href;
        });

        // Fallback: entire page (just in case portal changes structure)
        if (!found) {
          $('a').each(function () {
            if (found) return false;
            const $a   = $(this);
            const href = $a.attr('href') || '';
            if (!href.includes('booking-ore-exam')) return;
            if ($a.text().trim() !== 'Book') return;
            found = href.startsWith('http') ? href : 'https://mygdc.gdc-uk.org' + href;
          });
        }

        return found;
      };

      let pollTimer   = null;
      let safetyTimer = null;

      const finish = (href) => {
        clearInterval(pollTimer);
        clearTimeout(safetyTimer);
        resolve(href);
      };

      // Start polling IMMEDIATELY — don't wait for 'loaded' event.
      // applyExamLogic() injects the Book button into the DOM as soon as the
      // AJAX chain completes, regardless of when 'loaded' fires relative to us.
      // Polling from T=0 means we catch it within 100ms of it appearing,
      // even if the server is slow and the chain takes 3-4s under load.
      pollTimer = setInterval(() => {
        const href = findBookLink();
        if (href) finish(href);
      }, pollMs);

      // Hard timeout — give up and return null after maxMs
      safetyTimer = setTimeout(() => finish(findBookLink()), maxMs);

      $grid.trigger('refresh');
    });
  }, {
    venueFilter: venueFilter || '',
    pollMs:  CONFIG.gridPollIntervalMs,
    maxMs:   CONFIG.gridPollMaxMs,
  });
}

// ─── FULL PAGE RELOAD FALLBACK ────────────────────────────────────────────────

async function reloadAndCheckBookButton(page, venueFilter) {
  await page.goto(`${BASE_URL}/exams/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait for the portal spinner to clear (up to 12 s)
  await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 12000 }).catch(() => {});
  await sleep(500);

  const href = await page.evaluate((vf) => {
    let found = null;
    // Primary: action-cell links (exactly how the portal injects the Book link)
    document.querySelectorAll('td.action-cell a').forEach(a => {
      if (!(a.href || '').includes('booking-ore-exam')) return;
      if (a.textContent.trim() !== 'Book') return;   // exact case match
      if (vf) {
        const row = a.closest('tr');
        if (!row) return;
        const cells = row.querySelectorAll('td');
        const venue = cells[1] ? cells[1].textContent.trim().toLowerCase() : '';
        if (!venue.includes(vf.toLowerCase())) return;
      }
      found = a.href;
    });
    // Fallback: any link
    if (!found) {
      document.querySelectorAll('a').forEach(a => {
        if (!(a.href || '').includes('booking-ore-exam')) return;
        if (a.textContent.trim() !== 'Book') return;
        found = a.href;
      });
    }
    return found;
  }, venueFilter || '');

  return href || null;
}

// ─── BOOK THE EXAM ─────────────────────────────────────────────────────────────

async function confirmBooking(page, bookingHref) {
  console.log(`[${ts()}][book] → ${bookingHref}`);
  await page.goto(bookingHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log(`[${ts()}][book] ✅  Booking page loaded – COMPLETE IT MANUALLY IN THE BROWSER NOW.`);
  return true;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const openTime    = buildBookingOpenTime();
  const preWarmTime = new Date(openTime.getTime() - CONFIG.preWarmLeadSec  * 1000);
  const snipeTime   = new Date(openTime.getTime() - CONFIG.snipeLeadSec    * 1000);

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

  // ── STEP 1: Manual login ──────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/exams/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // If redirected to login page, wait for the user to log in manually
  if (!page.url().includes('mygdc.gdc-uk.org/exams')) {
    console.log(``);
    console.log(`[${ts()}] ⚠️  NOT LOGGED IN — please log in manually in the browser window.`);
    console.log(`[${ts()}]    1. Enter your email and password`);
    console.log(`[${ts()}]    2. Complete any MFA / email verification code`);
    console.log(`[${ts()}]    3. Script continues automatically once you reach the exams page.`);
    console.log(``);
    try {
      await page.waitForURL(`**mygdc.gdc-uk.org/exams**`, { timeout: 300_000 });
    } catch (_) {
      // If still not on exams page after 5 min, check again before giving up
      if (!page.url().includes('mygdc.gdc-uk.org/exams')) {
        console.log(`[${ts()}] ⚠️  Still not on exams page — check the browser window.`);
        await page.waitForURL(`**mygdc.gdc-uk.org/exams**`, { timeout: 300_000 });
      }
    }
  }

  await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 15000 }).catch(() => {});
  console.log(`[${ts()}] ✅ On exams page. Waiting for pre-warm phase...`);
  console.log(`[${ts()}] ⚡ IMPORTANT: Keep this laptop plugged in and screen/sleep disabled until after 14:30 tomorrow.`);

  // ── STEP 2: Keep-alive – grid refresh every 10 s until pre-warm ─────────────
  // Light-touch: fire the portal's own grid refresh AJAX every 10 s instead of
  // a full page reload. This sends one POST request, keeps the session warm,
  // and leaves the existing table rows untouched if the call fails or returns
  // nothing. Every 5 minutes we also do a full page reload to renew cookies.
  let kaCounter = 0;
  while (true) {
    const waitMs = Math.min(10_000, msUntil(preWarmTime) - 5000);
    if (waitMs <= 0) break;
    await sleep(waitMs);
    if (msUntil(preWarmTime) <= 0) break;

    kaCounter++;
    const minsLeft = Math.ceil(msUntil(preWarmTime) / 60_000);

    if (kaCounter % 30 === 0) {
      // Every ~5 min: full reload to renew session cookies / CSRF token
      console.log(`[${ts()}] [keep-alive #${kaCounter}] Full reload (session renew, ~${minsLeft}m to pre-warm)...`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('exam-loading-spinner'), { timeout: 10000 }).catch(() => {});
    } else {
      // Lightweight grid refresh — if it fails, original rows are untouched
      const ok = await page.evaluate(() => {
        try {
          if (typeof $ === 'undefined') return false;
          const $g = $('#schedulelist .entity-grid');
          if (!$g.length) return false;
          $g.trigger('refresh');
          return true;
        } catch (_) { return false; }
      }).catch(() => false);
      console.log(`[${ts()}] [keep-alive #${kaCounter}] Grid ${ok ? 'refreshed ✓' : 'refresh skipped — rows kept'} (~${minsLeft}m to pre-warm)`);
    }
  }

  // Wait for the exact pre-warm start time
  if (msUntil(preWarmTime) > 0) await sleep(msUntil(preWarmTime));

  // ── STEP 3: Pre-warm – full reload every 8 s until snipe phase ────────────
  console.log(`[${ts()}] ── PRE-WARM phase (full reloads every ${CONFIG.preWarmIntervalMs/1000}s) ──`);
  while (msUntil(snipeTime) > 0) {
    console.log(`[${ts()}] [pre-warm] Reloading (${Math.round(msUntil(openTime)/1000)}s until open)...`);
    await page.goto(`${BASE_URL}/exams/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(1500, 200);

    const wait = Math.min(CONFIG.preWarmIntervalMs, msUntil(snipeTime));
    if (wait > 500) await sleep(wait);
  }

  // Final reload to ensure page + jQuery are fully initialised before snipe
  console.log(`[${ts()}] Final pre-snipe full reload...`);
  await page.goto(`${BASE_URL}/exams/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => typeof $ !== 'undefined' && $('#schedulelist .entity-grid').length > 0, { timeout: 10000 }).catch(() => {});
  console.log(`[${ts()}] jQuery + grid confirmed ready ✓`);

  // Fire the first snipe preFireMs BEFORE 14:30:00 so that the AJAX chain
  // inside applyExamLogic (~895 ms: grid+waitingList+bookings) completes right
  // at 14:30:00 — when `now >= bookingStart` becomes true client-side.
  //
  // Timeline of first snipe (assuming <1ms ping, fired at 14:29:59.100):
  //   14:29:59.100  trigger('refresh') sent
  //   14:29:59.500  grid data returns, 'loaded' fires
  //   14:29:59.760  waitingList AJAX returns
  //   14:30:00.000  bookings AJAX returns → applyExamLogic checks now >= 14:30:00 ✓
  //   14:30:00.010  100ms poller catches Book button
  //   14:30:00.010  navigate to booking page
  const firstFireTime = new Date(openTime.getTime() - CONFIG.preFireMs);
  if (msUntil(firstFireTime) > 0) {
    console.log(`[${ts()}] Waiting ${(msUntil(firstFireTime)/1000).toFixed(1)}s → pre-fire at ${firstFireTime.toLocaleTimeString('en-GB')} (${CONFIG.preFireMs}ms before open)...`);
    await sleep(msUntil(firstFireTime));
  }

  // ── STEP 4: RAPID SNIPE ───────────────────────────────────────────────────
  console.log(`[${ts()}] ══ SNIPE START (${CONFIG.preFireMs}ms pre-fire) ══`);
  let booked = false;
  let fullReloadFallback = false;

  for (let i = 1; i <= CONFIG.snipeMaxAttempts; i++) {
    const t0 = Date.now();
    console.log(`[${ts()}] [snipe #${i}] firing grid refresh...`);

    try {
      let bookHref = null;

      if (!fullReloadFallback) {
        // Fast path: trigger portal's grid refresh event (no full page reload)
        bookHref = await triggerGridRefreshAndCheckBookButton(page, CONFIG.targetVenueFragment);
        if (bookHref === null && i % 2 === 0) {
          // Every 2nd attempt also do a full reload — covers the case where the
          // portal only injects the Book button on a full page load, not grid refresh
          console.log(`[${ts()}] [snipe #${i}] Safety full reload...`);
          bookHref = await reloadAndCheckBookButton(page, CONFIG.targetVenueFragment);
        }
      } else {
        bookHref = await reloadAndCheckBookButton(page, CONFIG.targetVenueFragment);
      }

      if (bookHref) {
        console.log(`[${ts()}] [snipe #${i}] 🎯 BOOK LINK FOUND → ${bookHref}`);
        booked = await confirmBooking(page, bookHref);
        if (booked) break;
        // If confirm failed, fall back to full reload mode for safety
        fullReloadFallback = true;
      } else {
        console.log(`[${ts()}] [snipe #${i}] No Book button yet (${Date.now() - t0}ms)`);
      }
    } catch (err) {
      console.error(`[${ts()}] [snipe #${i}] Error: ${err.message} — switching to full-reload fallback`);
      fullReloadFallback = true;
    }

    if (!booked && i < CONFIG.snipeMaxAttempts) {
      // 2 s between snipes, minus time already spent this iteration
      // Small random jitter (±200ms) makes the interval look human-like
      const elapsed = Date.now() - t0;
      const remaining = Math.max(0, CONFIG.snipeIntervalMs - elapsed);
      await sleep(remaining, 200);
    }
  }

  if (!booked) {
    console.warn(`[${ts()}] ⚠️  Did not complete booking. Check booking-page.png.`);
  }

  console.log(`[${ts()}] Script finished. Browser left open — press Ctrl+C to quit.`);
  await new Promise(() => {}); // keep browser open for manual review / payment
}

main().catch(err => {
  console.error('[fatal]', err.message);
  console.log('[fatal] Script crashed but browser is kept open. Press Ctrl+C to exit.');
  // Do NOT call process.exit — keep Chrome open so you can see the booking page
  return new Promise(() => {});
});
