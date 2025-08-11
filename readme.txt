You are a senior front-end engineer. Create a production-quality Plinko web game that mimics Stake.com’s Plinko behavior and UX, implemented with vanilla HTML/CSS/JS (no frameworks). Prioritize clean architecture, accessibility, and performance.

1) Deliverables & Structure
Output three files:

index.html

styles.css

plinko.js

No build tools. Must run locally by opening index.html.

Use semantic HTML and ARIA where relevant.

2) Core Gameplay
A triangular grid of pins (8–16 rows, configurable). The bottom has N+1 slots with visible multiplier labels (e.g., 0.2×, 0.5× … 1,000× depending on risk).

On Drop, spawn a ball at the top center. The ball “falls” row by row, randomly bouncing left or right at each pin with small horizontal variance. You can simulate physics either:

Canvas: simple step physics (gravity, collisions with circular pins, floor slots), OR

Discrete: step per row with tweened animation between pins.

Ensure deterministic outcomes when a “client seed”, “server seed”, and “nonce” are set (see “Provably Fair” below). If seeds are unchanged, the same drop index yields the same final slot.

Ending condition: ball settles in a slot; show win amount = bet × multiplier.

3) Config & Risk Model
Implement three risk levels: low, medium, high.

Implement row count: integer 8–16.

Each risk/rows combo has a payout map (array of multipliers, symmetric around center). Provide default tables for 8, 12, 16 rows for all 3 risk levels. Example (you can tune values but must keep symmetry and realistic volatility):

js
Copy
Edit
const PAYOUT_TABLES = {
  low: {
    8:  [0.5,0.7,0.9,1,1.1,0.9,0.7,0.5,0.3],
    12: [0.3,0.5,0.7,0.9,1,1.1,1.1,1,0.9,0.7,0.5,0.3,0.2],
    16: [0.2,0.3,0.4,0.6,0.8,0.9,1,1.05,1.05,1,0.9,0.8,0.6,0.4,0.3,0.2,0.1]
  },
  medium: {
    8:  [0.2,0.5,0.8,1,2,1,0.8,0.5,0.2],
    12: [0.1,0.3,0.5,0.8,1,2,3,2,1,0.8,0.5,0.3,0.1],
    16: [0.1,0.2,0.3,0.5,0.8,1,2,4,4,2,1,0.8,0.5,0.3,0.2,0.1,0.05]
  },
  high: {
    8:  [0.2,0.3,0.5,1,5,1,0.5,0.3,0.2],
    12: [0.1,0.2,0.3,0.5,1,5,15,5,1,0.5,0.3,0.2,0.1],
    16: [0.05,0.1,0.15,0.3,0.5,1,5,25,100,25,5,1,0.5,0.3,0.15,0.1,0.05]
  }
};
Center index maps to ~1× for low/medium; high risk skews more extreme.

Provide a visible payout strip under the board that updates live with risk/rows.

4) UI/UX Requirements
Left control panel:

Numeric Bet input (+/– stepper).

Risk selector (Low/Medium/High).

Rows selector (8–16).

Drop button.

Autoplay controls:

Toggle On/Off

Number of runs

On win/lose modifiers (e.g., increase bet by X%, reset on win, stop at profit target/loss limit)

Instant mode (skip animation)

Hotkeys info: Space = Drop, A = toggle autoplay, I = instant mode.

Board area (center):

Responsive canvas (or SVG) with pins, falling ball(s), and bottom slots with multipliers.

Smooth animations; capped FPS for performance.

Right panel:

Balance (start with e.g. 10,000 demo credits).

Win/Loss of last drop.

History list (last 20 results): bet, multiplier, win amount, final slot index, hash preview.

Stats: total bets, total wagered, total won, RTP approximation (running).

Tabs under controls:

Fairness tab (see below).

Settings tab (sound on/off, animation speed).

Mobile responsive: controls stack; board remains visible.

5) Provably Fair (Deterministic RNG)
Implement a cryptographically simple, deterministic PRNG pipeline:

Inputs:

Server seed (hashed shown, secret stored): default random on first load.

Client seed: editable text input.

Nonce: increments per drop.

RNG:

Derive a per-drop HMAC-SHA256 of {serverSeed}:{clientSeed}:{nonce}:{dropIndex}.

Convert digest to a series of uniform floats in [0,1).

Use these floats to decide left/right at each pin (or to pick final slot directly if using discrete math).

Fairness tab UI:

Show Server seed (hash), Client seed, Nonce, and Drop index.

Button: Reveal/Rotate server seed (when rotated, store previous revealed seed & hash, generate a new one, reset nonce).

Verify section:

Given seeds, nonce, and drop index, recompute the path and final slot. Display that result so the user can cross-check.

Implement HMAC-SHA256 in JS (Web Crypto API if available; otherwise a tiny, audited lib).

6) Game Logic Details
Discrete mode (recommended for deterministic + speed): With R rows, compute R left/right steps using the PRNG; final slot index = number of rights. Animate the path with bezier curves between pins for visual realism.

Physics mode (optional): If you implement physics, still bind final slot to PRNG results to keep determinism (i.e., physics is visual only; outcome follows seeded decisions).

Allow multiple concurrent balls in autoplay (queue + small stagger). In Instant mode, skip animation and immediately settle outcomes.

7) Autoplay Rules
Options:

Rounds: integer up to, say, 10,000.

On win: increase bet by X%, or reset to base.

On loss: increase bet by X%, or reset to base.

Stop conditions: stop if balance ≤ stop-loss, or profit ≥ take-profit.

Speed slider (disabled in Instant mode).

Show a small autoplay status chip (“Running n/N”).

8) Balance, Bets, & History
Start with demo balance (10,000).

On drop:

Deduct bet from balance, then add winnings after settle.

Log result into history array (max 100). Persist to localStorage (balance, seeds, settings, history).

Show toast/inline message on big wins (e.g., ≥25×).

9) Accessibility & Polish
Keyboard accessible controls; aria-pressed for toggles.

Focus states, proper labels, and readable contrast.

Smooth transitions; no layout shift.

FPS guard for canvas (requestAnimationFrame); avoid unnecessary reflows.

10) Code Quality
plinko.js organized as modules (IIFE or ES modules if allowed by a simple <script type="module">):

state: balance, seeds, nonce, config.

rng: HMAC + float extraction.

payouts: lookup & validation.

engine: compute outcome, update state, history.

render: draw board/ball/slots; resize handling.

ui: wire controls, hotkeys, localStorage.

fairness: verify UI + seed rotation.

JSDoc comments for public functions.

Defensive checks (invalid bet, insufficient balance, invalid seeds).

11) Testing Hooks
Add a “Test Run” button in Settings to drop, e.g., 1,000 instant runs and compute empirical hit rates vs. theoretical binomial probabilities for the current rows (display a small table).

Ensure determinism: With a fixed seeds+nonce, the first 100 drops must be identical across reloads.

12) Styling
Clean, casino-like but minimal:

Dark background, subtle gradients.

Pins as small circles, ball as a slightly glowing disc.

Bottom slots colored; hover shows multiplier.

All styles in styles.css. Avoid inline styles.

13) Example HTML Skeleton (guide)
Header with title and balance.

Main split into 3 columns: Controls | Board | Info.

Footer with small print (“Demo only. Not gambling.”).

14) Acceptance Criteria
Changes to risk or rows update payout labels and logic immediately.

Provably fair tab can reproduce any past result from history by seeds+nonce+drop index.

Autoplay respects stop conditions.

Instant mode resolves 1,000 drops in under a second on a typical laptop.

No console errors; passes basic Lighthouse checks (≥90 performance/accessibility).

15) Nice-to-Have (if time permits)
Sound effects (toggleable).

Multi-ball “spray” mode (drop 5 at once; resolve sequentially).

Export history as CSV.

Important: Include well-commented code and a short README section at the top of plinko.js describing how to change default payout tables, seeds, and starting balance.
