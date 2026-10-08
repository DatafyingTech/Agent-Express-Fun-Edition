# Agent Express — design system for the Agent Office companion app (`/app`)

Owner: Design Research / Design System. Tokens: `src/client/app/tokens.css` (every value below exists
there as an `--a-*` custom property; component CSS uses tokens, never raw hex).
Audience: the UI engineers building `/app` in plain TypeScript + DOM (`h()` from `src/client/ui/dom.ts`)
and plain CSS. No React, no Tailwind, no component library.

---

## 0. The one-paragraph brief

Sam wants to text her household helpers, see who needs her, glance at what the team knows, and
open the budget. She does not want a game, a dashboard, or a terminal. **Agent Express** is a calm, warm,
grown-up messaging app over the same office: oat-paper backgrounds, ink text, one warm clay accent
that always means *"your move"*, a soft serif for headings and a clear sans for everything else.
Each screen has one obvious thing to do. Status is told in words first, color second. Motion is
felt, not watched.

---

## 1. Name

**Agent Express**. Your team of Claude Code agents, a message away: quick to reach, easy to say, and
it names what the app is for without sounding like a control panel. The look keeps the old app's
warmth (the 3D office's orange accent becomes the app's deeper clay). The same team as a 3D office
game is **Agent Express (Fun Edition)**.

- Wordmark: "Agent Express" set in Fraunces 600, `SOFT` 100, tracking -0.02em, ink color. A small
  clay dot after it is the only logo mark: `Agent Express·` (the dot is `--a-clay`, 0.28em circle, baseline).
- Page `<title>`: `Agent Express`, or `Meal Planner · Agent Express` on a chat.
- The 3D office stays "Agent Office" (or the Fun Edition). Apart from its own name, the app never shows
  the words office, floor, worker, PTY, worktree, session, terminal, prompt, agent, model, token.

## 2. Personality

| We are | We are not |
|---|---|
| Calm, warm, kind, quietly confident | Cute, cartoonish, loud, "AI magic" sparkles |
| A good assistant's note on the kitchen table | A control panel |
| Plain words, full sentences | Status codes, jargon, ALL CAPS |
| Generous space, few elements | Dense toolbars, every action visible at once |

**Signature elements** (the things that make it Agent Express and not a template):
1. **The greeting.** Home opens with a Fraunces line — "Good evening, Sam." — and one written
   sentence that summarizes the house: "Meal Planner needs you. Everyone else is humming along."
2. **Clay means your move.** The single accent is used only for: primary buttons, Sam's own chat
   bubbles, and anything that needs her. If something is clay, it's for her.
3. **The breathing ring.** A teammate who is working has a soft lake-blue ring around their emoji
   avatar that slowly breathes (2.8 s). Needs-you is a solid clay ring with a dot. Resting is a
   quiet, slightly faded avatar. You can read the whole team by their rings.

## 3. Design principles

1. **One clear action per screen.** Every screen has exactly one primary (clay) button or one obvious
   tap target (the list). Everything else is secondary, ghost, or in the `…` menu.
2. **Words before color.** Every status has a text label ("Needs you", "Working on it"). Color and
   rings reinforce; they never carry meaning alone.
3. **The phone is the product.** Design at 390 px first. Primary actions sit in the bottom third
   (thumb zone): tab bar, composer, sticky sheet footers. The header holds only Back, title, `…`.
4. **Quiet by default.** Neutral surfaces, hairline borders, soft shadows. Color is rare, so it means
   something. No gradients for decoration, no second accent.
5. **Say it like a person.** Sentence case, contractions, the teammate's name, no system words.
6. **Never lose her words.** Drafts survive navigation and reloads; sends are optimistic with a clear
   retry; destructive actions confirm or offer Undo.
7. **Fast feels calm.** Optimistic UI, skeletons that match the final layout, no spinners over 300 ms
   without text, no layout shift.

---

## 4. Information architecture and navigation

### 4.1 Screens and routes

The shell's routes (`src/client/app/context.ts`) map to screens like this:

| Route | Screen | Where it lives |
|---|---|---|
| `home` | Home: greeting, Needs you, Spaces | Tab 1 |
| *(new)* `chats` | All chats, newest first (Messages-style) | Tab 2 — **needs one route added:** `{ view: 'chats' }` |
| `settings` | Settings | Tab 3 |
| `space` | A space: its teammates | pushed from Home / sidebar |
| `memory` | "What the team knows" | the space's **Notes** segment |
| `reports` | Reports list + viewer | the space's **Reports** segment |
| `chat` | One conversation | pushed from anywhere; full screen on phone |
| `hire` | Add teammates (crews) | sheet over the space |
| `meeting` | Group chat builder | sheet over the space |

`space`, `memory` and `reports` are presented as **one screen with a segmented control**
(Team · Notes · Reports); switching segments calls `ctx.go()` with the matching route so the URL,
Back and reload all work, but visually only the content below the control changes.

### 4.2 Phone (< 700 px): bottom tab bar + push navigation

```
┌──────────────────────────────┐
│ status bar (safe-area-top)   │
│ ‹ Back        Title       …  │  header, 56 px, translucent over content
│                              │
│         content              │
│                              │
├──────────────────────────────┤
│  ⌂ Home   💬 Chats   ⚙ Settings │  tab bar, 56 px + safe-area-bottom
└──────────────────────────────┘
```

- **Three tabs: Home, Chats, Settings.** Icons + always-visible labels (13 px). Chats carries a clay
  count badge = teammates that need her. Active tab: ink icon + label, 600 weight; inactive: `--a-ink-3`.
- **Why a tab bar:** Sam's jobs are few and repeat daily; a tab bar keeps "who needs me" one thumb
  tap away from anywhere, sits in the thumb zone, and is the pattern she already knows from Messages,
  Health, and Photos. Three items is well under the ≤ 5 rule. A hamburger would hide the one thing that
  matters (Needs you).
- **Chat hides the tab bar** (the composer owns the bottom edge). Sheets cover it.
- Space-level things (Notes, Reports, Add teammates, Group chat) are *inside* a space, not tabs,
  because they only make sense for one space.
- Back: header `‹` (label = previous screen's title, truncated) + iOS edge-swipe works because it's
  the browser's history (routes push to the hash).

### 4.3 Tablet (700–1023 px): icon rail + content

A 72 px left rail with the three destinations (icon + 12 px label) and, below a divider, one 44 px
tile per visible space (its emoji, clay dot if something needs her). Content is centered, max 680 px
for chat/notes, 1040 px for grids. Chat keeps the rail.

### 4.4 Desktop (≥ 1024 px): sidebar + content

```
┌───────────────┬─────────────────────────────────────────────┐
│ Agent Express·│                                             │
│               │   Good evening, Sam.                     │
│ ⌂ Home        │   Meal Planner needs you. Everyone else     │
│ 💬 Chats   (2) │   is humming along.                         │
│               │                                             │
│ SPACES        │   Needs you                                 │
│ 🏡 Home Life ● │   ┌───────────────────────────────────────┐ │
│ 💵 Personal…  │   │ 🍲 Meal Planner   Wants your OK on…  › │ │
│               │   └───────────────────────────────────────┘ │
│               │   Your spaces                               │
│               │   ┌──────────────┐ ┌──────────────┐         │
│               │   │ 🏡 Home Life │ │ 💵 Personal  │         │
│ ─────────     │   └──────────────┘ └──────────────┘         │
│ ⚙ Settings    │                                             │
│ Sam  ▾     │                                             │
└───────────────┴─────────────────────────────────────────────┘
  264 px, --a-bg-sunk        content on --a-bg, gutter 32 px
```

- Sidebar (`--a-sidebar-w` 264 px, background `--a-bg-sunk`, no border, right edge is the color change):
  wordmark (top, 24 px padding), Home, Chats, "Spaces" overline + one row per visible space, spacer,
  Settings, account row. Rows 40 px tall (hit area 44 via padding), radius `--a-r-sm`, selected row
  `--a-surface` + `--a-shadow-1`, ink 600.
- **Why a sidebar:** on a wide screen the spaces themselves become navigation (one click from
  anywhere), and the content column stays at a comfortable reading width instead of stretching.
- **Chat on desktop ≥ 1200 px:** two columns inside the content area: conversation list (320 px) +
  conversation (flex, bubbles capped at `--a-bubble-max`). Below 1200 px: one column, list OR chat.

### 4.5 Breakpoints

`< 700` phone · `700–1023` tablet (rail) · `≥ 1024` desktop (sidebar) · `≥ 1200` split chat.
Use `min-width` media queries, phone styles are the default.

---

## 5. Data → words (status mapping)

Teammate status in the UI is derived from `WorkerInfo.status` + `acked`:

| Server | UI label | Ring / dot | Chip style | Where it shows |
|---|---|---|---|---|
| `needs_input` | **Needs you** | solid clay ring + clay dot | `clay-soft` / `clay-on-soft` | Needs you inbox, top of lists |
| `done` && `!acked` | **Finished** | moss dot (no ring) | `moss-soft` / `moss-on-soft` | Needs you inbox ("take a look") |
| `starting`, `working` | **Working on it** | lake ring, breathing | `lake-soft` / `lake-on-soft` | — |
| `idle`, `done` && `acked` | **Ready** | none | `stone-soft` / `stone-on-soft` | — |
| `exited`, `offline` | **Resting** | none; avatar at 55% saturation, 80% opacity | `stone-soft` | "Wake" action |

- The one-line "what they're doing": `activity` (needs input) → `task.summary` → `prompt`, first
  sentence, ≤ 80 chars, ellipsis `…`. Never show raw tool names or paths; if the only text available
  looks technical (contains `/`, `\`, `()`, `.ts`, `npm`), show the generic line for the status
  instead ("Working on it", "Waiting for your answer", "All done — take a look").
- Sort order everywhere: Needs you → Finished (unacked) → Working → Ready → Resting; then by
  `waitingSince` (oldest first) / most recent activity.

---

## 6. Screens

All widths: phone 390 × 844 reference; gutter `--a-gutter` (20 px phone, 32 px desktop).

### 6.1 Home

```
┌──────────────────────────────┐
│                              │  no header bar on Home; greeting is the header
│ Good evening,                │  Fraunces 34/40, 500 (display)
│ Sam.                      │
│ Meal Planner needs you.      │  callout 15/22, ink-2, max 2 lines
│ Everyone else is humming…    │
│                              │
│ Needs you                 2  │  title-3 17/24 600 + count in ink-3
│ ┌──────────────────────────┐ │
│ │(🍲) Meal Planner    now  │ │  inbox card: avatar 48 (clay ring)
│ │     Wants your OK on the │ │  line 2: 15 px ink-2, 2 lines max
│ │     grocery order        │ │
│ │     [ Reply ]            │ │  optional quick action (secondary sm)
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │(🧾) Household Acct.  2h  │ │  moss dot = finished
│ │     Finished: September  │ │
│ │     budget is ready      │ │
│ └──────────────────────────┘ │
│                              │
│ Your spaces                  │
│ ┌────────────┐┌────────────┐ │  space cards, 2 per row on phone
│ │ 🏡          ││ 💵          │ │  (1 per row under 360 px)
│ │ Home Life   ││ Personal   │ │  Fraunces 20/26
│ │ 3 working   ││ Finance    │ │  caption status summary
│ │ ◐◐◐ ●       ││ All quiet  │ │  up to 4 mini avatars (24 px)
│ └────────────┘└────────────┘ │
└──────────────────────────────┘
```

- **Greeting**: "Good morning" (5–11:59), "Good afternoon" (12–16:59), "Good evening" (17–4:59) + the
  signed-in first name. Summary sentence rules (first that applies):
  - 1 needs you: "{Name} needs you." + " Everyone else is humming along." if others are working.
  - 2+: "{n} teammates need you."
  - only finished: "{Name} finished something for you." / "{n} things are ready for you."
  - some working: "{n} teammates are working on things."
  - nothing: "All quiet. Nothing needs you right now."
- **Needs you** list: cards (not rows) so they feel like notes left for her. Max 5, then a
  "See all {n}" ghost button → Chats. Tapping a card opens the chat. Empty: the section is replaced by
  a single line in ink-3: "You're all caught up." (no big empty-state illustration on Home).
- **Your spaces**: only spaces enabled in Settings. Card = `--a-surface`, radius lg, shadow-1,
  padding 16. Top-left: 40 px tile with the space emoji (department icon) on
  `color-mix(var(--a-space) var(--a-tint), surface)`. Title Fraunces 20/26 500. Status line caption:
  "1 needs you" (clay-text, 600) / "3 working" / "All quiet". Bottom: up to 4 overlapping 24 px avatars
  (ring 2 px `--a-surface` to separate).
- Desktop: greeting + Needs you in a 680 px column; spaces grid `repeat(auto-fill, minmax(240px, 1fr))`
  up to 1040 px.

### 6.2 Chats (tab)

Messages-style list of every teammate in visible spaces who has ever been chatted with or is awake.

```
│ Chats                        │  title-1 Fraunces 28/34, left-aligned, 16 px below safe area
│ ┌──────────────────────────┐ │
│ │(🍲) Meal Planner  · 2m   │ │  row 72 px: avatar 48, name 17/24 600, time caption ink-3
│ │     Home Life            │ │  space name caption ink-3
│ │     Wants your OK on…  ● │ │  preview 15/22 ink-2 1 line; clay dot if needs you
│ ├──────────────────────────┤ │  inset divider starts after avatar (left 76 px)
```

- Grouped into one inset list (`--a-surface`, radius md, shadow-1). Needs-you rows first.
- Filter segmented control at top when > 8 chats: **All · Needs you**.
- Empty: "No chats yet" / "Open a space and tap a teammate to start." + button "Go to your spaces".

### 6.3 Space (route `space`, `memory`, `reports`)

```
┌──────────────────────────────┐
│ ‹ Home                    …  │  header; … = Wake everyone, Space settings
│ 🏡 Home Life                 │  Fraunces 28/34; emoji 28 px inline
│ 4 teammates · 1 needs you    │  callout ink-2
│ ┌──────────────────────────┐ │
│ │  Team  │ Notes │ Reports │ │  segmented control, full width, 44 px
│ └──────────────────────────┘ │
│ [👥 Group chat] [＋ Add teammates] │  secondary sm buttons, scroll-x if needed
│                              │
│ ┌──────────────────────────┐ │
│ │(🍲) Meal Planner      ›  │ │  teammate row 72 px
│ │     Needs you            │ │  status chip (clay-soft)
│ │     Wants your OK on the │ │  activity line 15 px ink-2, 2 lines max
│ │     grocery order        │ │
│ ├──────────────────────────┤ │
│ │(🧺) Home Organizer    ›  │ │
│ │     Working on it        │ │  lake chip; ring breathes
│ │     Sorting the garage…  │ │
│ ├──────────────────────────┤ │
│ │(🌱) Garden Helper [Wake] │ │  resting: faded avatar, "Wake" secondary sm
│ │     Resting              │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

- The **list is the primary action** (tap row → chat). No clay button on this screen unless the space
  is empty.
- Row: whole row is a `<button>` (or `<a href>`) → chat. "Wake" is a separate button inside the row's
  trailing slot (stopPropagation), 36 px visual / 44 px hit.
- Header `…` menu (popover desktop, action sheet phone): "Wake everyone" (only if ≥ 1 resting),
  "Group chat", "Add teammates", divider, "Open in the 3D office" (for the office owner; ghost, small).
- Empty space: empty state "No one's here yet" / "Add a few teammates and they'll get to work." +
  primary "Add teammates".
- Desktop ≥ 1024: rows become a 2-column grid of teammate cards (same content, 16 px padding,
  radius lg) under a 1040 px max width; action buttons move to the right of the title.

**Notes segment = "What the team knows" (route `memory`)**

```
│ What the team knows          │  title-2 Fraunces 22/28
│ Updated 2 hours ago          │  caption ink-3
│ ┌──────────────────────────┐ │
│ │ ## Budget basics         │ │  summary card: rendered markdown, reading type
│ │ Groceries are capped at  │ │  17/27, max 68ch; h2 Fraunces 20, h3 Figtree 17/600
│ │ $900/month…              │ │
│ │          [ Show all ]    │ │  collapses after ~12 lines with a fade + ghost button
│ └──────────────────────────┘ │
│ Recent notes                 │  title-3
│ Today                        │  overline ink-3
│  • 4:12 PM  Household Acct.  │  timeline row: time caption (tabular), who, text
│    Moved the Costco charge…  │
│ Yesterday                    │
│  • …                         │
│ Files                        │  title-3
│ ┌──────────────────────────┐ │
│ │ 📄 budget-2026.csv    ›  │ │  file rows 56 px: icon tile 36, name 16/600,
│ │    Updated Sep 28        │ │  meta caption; tap → viewer sheet / download
│ └──────────────────────────┘ │
```

- Log: newest first, grouped by day ("Today", "Yesterday", "Monday", "Sep 22"). Show 20, then
  "Show older".
- Empty: "Nothing written down yet" / "As your team learns things about the house, they'll keep
  notes here."

**Reports segment (route `reports`)**

- List of report cards: 40 px icon tile (chart icon on `lake-soft`), title 17/600, meta caption
  "Made by Household Accountant · Sep 28". Phone: single column; desktop: grid of cards
  (`minmax(280px,1fr)`).
- Open → full-screen viewer (phone) / large dialog 90vw × 90vh max 1100 px (desktop): header with Back
  / Close, title, `↗` "Open in a new tab" icon button. The report renders in an `<iframe>` on
  `--a-surface` (sandboxed as the existing reports code does).
- Empty: "No reports yet" / "Ask a teammate for one — for example, “Make me a chart of this month's
  spending.”" + button "Ask Household Accountant" (if present) → chat with draft prefilled.

### 6.4 Chat (route `chat`)

```
┌──────────────────────────────┐
│ ‹  (🍲) Meal Planner      …  │  header 56: back, avatar 32, name 17/600
│        Thinking…             │  status line caption; animated dots
├──────────────────────────────┤
│            Today             │  day separator: caption ink-3, centered
│ ┌───────────────────┐        │
│ │ Here's the plan for│       │  theirs: surface bubble + hairline,
│ │ this week: …       │       │  rendered markdown, max 85% width
│ └───────────────────┘        │
│ 4:10 PM                      │  time under last bubble of a group
│        ┌───────────────────┐ │
│        │ Swap Tuesday for  │ │  hers: clay bubble, on-clay text
│        │ tacos please      │ │
│        └───────────────────┘ │
│                  Sent 4:12 PM│
│ ┌──────────────────────────┐ │
│ │ Wants your OK            │ │  ask card (needs you): clay-soft
│ │ Place the grocery order  │ │
│ │ for $142.18?             │ │
│ │ [Yes, go ahead] [No]     │ │  primary + secondary
│ └──────────────────────────┘ │
├──────────────────────────────┤
│ ┌─┐┌───────────────────┐┌─┐  │  composer (see 7.10)
│ │📎││ Message Meal…     ││↑│  │
│ └─┘└───────────────────┘└─┘  │
└──────────────────────────────┘
```

- Status line (under the name; `aria-live="polite"`):
  "Thinking…" (working; animated dots) · "Needs your OK" (clay-text, 600) · "Finished" ·
  "Here" (ready) · "Resting — send a message to wake them" (resting).
- `…` menu: "Behind the scenes" (opens the raw terminal view — label never says terminal),
  "What the team knows", "Wake" / "Let them rest", divider, "Remove from space" (danger, confirms).
- Messages grouped: consecutive messages from the same sender within 5 minutes share one group;
  4 px between bubbles in a group, 16 px between groups. Only the last bubble in a group has the
  tail corner and the time.
- Her message is shown immediately (optimistic) with meta "Sending…" → "Sent"; on failure the bubble
  gets a danger outline and meta "Didn't send · Tap to retry".
- Scroll: open at the bottom. On new incoming messages, auto-scroll only if she's within 120 px of the
  bottom; otherwise show a floating pill "New message ↓" (surface, shadow-2, 36 px) above the composer.
- Long markdown: tables scroll horizontally inside the bubble; code blocks use `--a-font-mono` 14 px on
  `--a-code-bg`, radius sm; images max 100% of bubble, radius sm, tap to view full screen.
- Desktop ≥ 1200: left column = chat list (same rows as 6.2, compact 64 px), right = this screen.

### 6.5 Add teammates (route `hire`) — sheet

```
│ ───  (grabber)               │
│ Add teammates            ✕   │  title-2 Fraunces + close
│ Pick a crew, or one person.  │  callout ink-2
│ CREWS                        │  overline
│ ┌──────────────────────────┐ │
│ │ 🍲🧺🌱  Household crew   │ │  crew card: emoji cluster, name 17/600,
│ │ Meals, chores, garden.   │ │  one-line description, "3 teammates"
│ │ 3 teammates         ( ✓ )│ │  select = check circle (44 px hit)
│ └──────────────────────────┘ │
│ ONE AT A TIME                │
│ (🧾) Household Acct.     ( + )│  rows with add toggle; already-here rows
│ (🍲) Meal Planner   Already here│  disabled with caption
├──────────────────────────────┤
│ [      Add 3 teammates     ] │  sticky footer, primary lg, full width
└──────────────────────────────┘
```

- Only roster members for this space's department(s) are offered first; "Show everyone" ghost button
  reveals the rest (collapsed).
- Footer button label counts: "Add 1 teammate" / "Add 3 teammates"; disabled "Pick someone to add".
- After adding: sheet closes, toast "3 teammates are joining Home Life", rows appear with
  "Getting settled…" (starting).

### 6.6 Group chat builder (route `meeting`) — sheet

```
│ Start a group chat       ✕   │
│ WHO'S JOINING                │
│ (🍲✕)(🧾✕)                   │  selected chips (avatar 24 + name + ✕), wrap
│ ┌──────────────────────────┐ │
│ │ (🍲) Meal Planner    [✓] │ │  checkbox rows; ALL teammates of this space,
│ │ (🧾) Household Acct. [✓] │ │  resting ones marked "Will wake up"
│ │ (🧺) Home Organizer  [ ] │ │
│ └──────────────────────────┘ │
│ WHAT'S IT ABOUT?             │
│ ┌──────────────────────────┐ │
│ │ Plan October meals within│ │  textarea, 3 rows min, 16 px
│ │ the grocery budget…      │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│ [    Start group chat      ] │  primary; disabled until ≥ 2 people + a topic
│ 2 people · you'll be in it   │  caption, centered
```

- Nobody is pre-selected except a teammate she came from (if opened from a chat).
- Disabled-button reason is always visible as the caption ("Pick at least two people").

### 6.7 Settings (tab)

Inset grouped lists (iOS Settings style), 680 px max.

```
│ Settings                     │  title-1
│ SPACES                       │
│ ┌──────────────────────────┐ │
│ │ 🏡 Home Life        [●━] │ │  switch rows, 56 px
│ │ 💵 Personal Finance [●━] │ │
│ │ 📈 Market Watch     [━○] │ │
│ └──────────────────────────┘ │
│ Choose which spaces show up. │  footnote caption ink-3
│ APPEARANCE                   │
│ ┌──────────────────────────┐ │
│ │ [ Light | Dark | Auto ]  │ │  segmented control
│ └──────────────────────────┘ │
│ ACCOUNT                      │
│ ┌──────────────────────────┐ │
│ │ Signed in as Sam      │ │
│ │ Open the 3D office     ↗ │ │
│ │ Sign out                 │ │  danger-colored text, confirms in a dialog
│ └──────────────────────────┘ │
│ Agent Express                │  caption ink-3 footer (optional)
```

- Theme choice writes `<html data-theme>` and `localStorage["hearth.theme"]` and updates
  `<meta name="theme-color">` from `--a-theme-color`.
- Sign-out confirm: title "Sign out of Agent Express?", body "Your teammates keep working. You can sign back
  in any time.", buttons "Sign out" (danger) / "Cancel".

---

## 7. Components

Naming: every class starts with `a-` (block) and uses `--modifier` / `is-state` / `data-*` for
state. Build each as a small function returning an element via `h()`, e.g.
`button({ label, icon, variant, size, onClick })`, `avatar({ emoji, color, status, size })`.
Every interactive element is a real `<button>`, `<a href>`, `<input>`, or `<dialog>`; never a
clickable `<div>`.

### 7.1 Buttons — `.a-btn`

| Variant | Background | Text | Border | Use |
|---|---|---|---|---|
| `--primary` | `--a-clay` | `--a-on-clay` | none | the ONE main action on a screen/sheet |
| `--secondary` | `--a-surface` | `--a-ink` | 1px `--a-line-strong` | other actions |
| `--ghost` | transparent | `--a-ink-2` | none | tertiary, "Show all", "Cancel" |
| `--danger` | `--a-danger` | `--a-on-danger` | none | confirm destructive in a dialog only |
| `--danger-quiet` | transparent | `--a-danger` | none | "Sign out", "Remove…" rows |

| Size | Height | Padding x | Font | Radius |
|---|---|---|---|---|
| `lg` | 52 px | 20 px | 17/600 | `--a-r-md` (full-width in sheets on phone) |
| `md` (default) | 44 px | 16 px | 16/600 | `--a-r-md` |
| `sm` | 36 px visual, 44 px hit (`::before` inset -4px) | 12 px | 14/600 | `--a-r-sm` |

- Icon + label gap 8 px; icon 20 px (18 in sm). Icon-only buttons are `.a-icon-btn`: 44 × 44, radius
  pill, icon 22 px, `--a-ink-2`, hover `--a-surface-hover`, and **always** `aria-label`.
- States: hover = `--a-clay-hover` / `--a-surface-hover` (only under `@media (hover: hover)`);
  active = `transform: scale(var(--a-press-scale))` + `--a-clay-press`, `--a-dur-instant`;
  focus-visible = base ring; disabled = `--a-bg-sunk` background, `--a-ink-4` text, no shadow,
  `aria-disabled="true"` when the reason is shown nearby; loading = keep the label, add a 16 px
  spinner before it, `aria-busy="true"`, ignore further clicks.
- Transitions list properties explicitly: `background-color, color, transform, box-shadow`
  `var(--a-dur-fast) var(--a-ease-out)`. Never `transition: all`.

### 7.2 Cards — `.a-card`

`--a-surface`, radius `--a-r-lg`, `--a-shadow-1`, 1 px `--a-line` border in dark mode only (light uses
shadow). Padding 16 (phone) / 20 (desktop). Interactive cards: hover `--a-shadow-2` +
`--a-surface-hover`; active press-scale. Variants: `.a-card--needs` (inbox) adds a 3 px clay bar on
the left inside the radius (`box-shadow: inset 3px 0 0 var(--a-clay)`), `.a-space-card`.

### 7.3 List rows & groups — `.a-group`, `.a-row`

- `.a-group`: inset grouped list, `--a-surface`, radius `--a-r-md`, shadow-1, overflow hidden.
- `.a-row`: min-height 56 (single line) / 72 (with avatar + 2 lines); padding 12 16; grid
  `leading | text | trailing`, gap 12. Title 17/24 600 (or 16/600 for compact), subtitle 15/22
  `--a-ink-2`, meta caption `--a-ink-3` tabular-nums. Divider: 1 px `--a-line` inset from the text
  column (not under the avatar); none after last row.
- Trailing: chevron (`›`, 18 px `--a-ink-4`) for navigation, switch, check, or a small button.
- States: hover `--a-surface-hover`, active `--a-surface-press`, selected `--a-surface-press` +
  `aria-current="page"`.

### 7.4 Avatars — `.a-avatar`

- Circle; sizes 24 / 32 / 40 / 48 / 72 (`data-size`). Emoji centered at 55% of size; background
  `color-mix(in srgb, var(--a-who) var(--a-tint), var(--a-surface))` where `--a-who` is the worker's
  `color`. Fallback without emoji: first letter, Figtree 600, `--a-ink-2`.
- **Status ring** (`data-status="working|needs|done|ready|resting"`): drawn with
  `box-shadow: 0 0 0 2px var(--a-bg-of-parent), 0 0 0 4px <ring color>` so there's a 2 px gap.
  - `working`: lake ring; `@media (prefers-reduced-motion: no-preference)` animate ring opacity
    0.35 ↔ 1 over `--a-dur-breathe`, `ease-in-out`, infinite (animate a `::after` ring's opacity,
    not box-shadow).
  - `needs`: clay ring + 10 px clay dot at top-right with 2 px surface border. When a teammate
    *becomes* needs-you: one 600 ms pulse (scale 1 → 1.08 → 1), never looping.
  - `done` (unacked): moss 10 px dot at top-right, no ring.
  - `ready`: nothing.
  - `resting`: `filter: saturate(.55); opacity: .8`, no ring.
- The avatar is decorative (`aria-hidden="true"`); the row's text carries name + status.
- Stack (`.a-avatar-stack`): 24 px avatars overlapping by 8 px, each with a 2 px `--a-surface` ring.

### 7.5 Status chip — `.a-status`

Height 24, padding 0 8, radius `--a-r-xs`, caption 13/18 600, 6 px dot + label, gap 6. Colors from
the table in §5 (`*-soft` background, `*-on-soft` text, dot = the base hue). Always includes the text.

### 7.6 Badges — `.a-badge`

Count: min-width 20, height 20, radius pill, padding 0 6, `--a-clay` + `--a-on-clay`, 12/20 700,
tabular-nums, "9+" cap. Dot: 8 px (`.a-badge--dot`). On a tab icon: top-right, 2 px ring of the bar
background. Screen readers: the tab's accessible name includes it ("Chats, 2 need you").

### 7.7 Segmented control — `.a-seg`

Track `--a-bg-sunk`, radius `--a-r-md`, padding 3, height 44 (phone) / 36 (desktop, hit area still
≥ 24 px per WCAG 2.5.8, and 44 on touch). Segments equal width, 15/600, `--a-ink-2`. Selected:
`--a-surface` pill with `--a-shadow-1`, `--a-ink`, radius `calc(var(--a-r-md) - 3px)`, the pill slides
(`transform: translateX`) `--a-dur-base --a-ease-out`. Markup: `role="tablist"` + `role="tab"` +
`aria-selected` for Team/Notes/Reports; `role="radiogroup"` + radios for the theme picker.
Arrow keys move selection.

### 7.8 Switch (settings) — `.a-switch`

`<input type="checkbox" role="switch">` styled: 51 × 31 track radius pill; off `--a-line-strong`,
on `--a-moss` (not clay: turning a space on isn't "your move", it's a setting); 27 px white knob,
`--a-shadow-1`, slides `--a-dur-base`. Whole row is the `<label>`.

### 7.9 Chat bubbles — `.a-bubble`

- `.a-bubble--me`: right-aligned, `--a-bubble-me-bg`, `--a-bubble-me-ink`, radius `--a-r-lg`, with
  bottom-right corner `--a-r-bubble-tail` on the last of a group. Links underlined in
  `--a-bubble-me-link`.
- `.a-bubble--them`: left-aligned, `--a-bubble-them-bg`, 1 px `--a-bubble-them-line`, shadow-1,
  bottom-left tail corner. Full markdown (via `src/client/ui/markdown.ts`), reading line-height 1.55.
- Padding 10 14; max-width 85% (phone) / `--a-bubble-max` (desktop); body 16/24.
- Meta line under a group: caption `--a-ink-3`, aligned to the bubble side.
- System line (joined, woke up, group chat started): centered caption `--a-ink-3`, no bubble:
  "Meal Planner woke up".
- Group chat: theirs-bubbles show the sender's name (caption 600, sender's color mixed 60% with ink)
  above the first bubble of each group and a 24 px avatar beside the last one.
- Enter animation: `opacity 0 → 1`, `translateY(var(--a-rise)) → 0`, `--a-dur-base --a-ease-out`.

### 7.10 Composer — `.a-composer`

```
┌──────────────────────────────────────────┐  bar: --a-bar-bg + --a-blur-bar, top hairline
│ [🖼 photo.jpg ✕] [📄 receipt.pdf ✕]        │  attachment chips row (scroll-x), only if any
│ (📎)  ┌──────────────────────────┐   (↑)   │
│       │ Message Meal Planner…     │         │  field: bg-sunk, radius xl, 44 min height
│       └──────────────────────────┘         │
└──────────────────────────────────────────┘  padding-bottom: max(8px, safe-area-bottom)
```

- Attach `.a-icon-btn` (paperclip) → hidden `<input type="file" accept="image/*,application/pdf"
  multiple>`. On phones this opens the native picker (Photo Library / Take Photo / Choose File), so no
  custom sheet is needed. Desktop also accepts paste (images from clipboard) and drag-and-drop onto
  the whole chat (a dashed clay drop overlay "Drop to attach") — drag is never the only way.
- Field: `<textarea rows="1">` auto-grows 1 → 6 lines (then scrolls), 16 px text (prevents iOS zoom),
  placeholder "Message {Name}…" in `--a-ink-3`, `autocapitalize="sentences"`, `spellcheck`,
  `enterkeyhint="send"` on desktop only. `aria-label="Message {Name}"`.
- Send: 36 px clay circle (44 hit) with arrow-up icon, `aria-label="Send"`. Hidden-by-scale (0.8,
  opacity 0) when empty and no attachment; appears with `--a-dur-fast`. Disabled while uploading.
- Keys: fine pointer (`matchMedia('(pointer: fine)')`): Enter sends, Shift+Enter newline. Coarse
  pointer (phones): Enter = newline; only the button sends.
- Draft is saved per teammate (`sessionStorage["hearth.draft.{id}"]`) on input, restored on open.
- Don't autofocus the field on phones (keyboard jumps the layout); do autofocus on desktop.
- When the teammate needs her, placeholder becomes "Reply to {Name}…".

**Attachment chip — `.a-attach`**: image = 56 × 56 thumbnail, radius `--a-r-sm`, remove button
(22 px visual, 44 hit) overlapping top-right; file = 44 px tall pill, file icon, name (ellipsis in the
middle, max 180 px), size caption ("1.2 MB", non-breaking space). States: uploading (circular progress
ring over the thumb), error (danger-soft background, "Couldn't add · Retry").

### 7.11 Ask card — `.a-ask`

Shown in the chat stream (and optionally on the Home inbox card) when a teammate needs a yes/no.
`--a-clay-soft` background, radius lg, padding 16. Overline "WANTS YOUR OK" in `--a-clay-on-soft`,
question 16/24 `--a-ink`, buttons row: primary "Yes, go ahead", secondary "No", ghost
"Reply instead" (focuses the composer). If the underlying question can't be answered with buttons,
show only the text and the status line; the composer placeholder switches to "Reply to {Name}…".

### 7.12 Typing / thinking indicator — `.a-typing`

Three 6 px `--a-ink-3` dots in a small theirs-bubble (height 36), each animating opacity 0.3 → 1
over 1.2 s, staggered 160 ms; reduced motion: static "Thinking…" text. `aria-hidden`; the header
status line announces "Thinking…".

### 7.13 Sheets and dialogs — `.a-sheet`, `.a-dialog`

- Use native `<dialog>` + `showModal()` (free focus trap, Esc to close, inert background). Return
  focus to the opener on close.
- **Phone: bottom sheet.** Full width, radius `--a-r-xl` on top corners, `--a-surface`,
  `--a-shadow-3`, max-height `92dvh`, 36 × 5 grabber (`--a-line-strong`, 8 px from top), title row
  (title-2 + close icon button), scrollable body, sticky footer for the primary action with
  `padding-bottom: max(16px, var(--a-safe-bottom))`. Enter: `translateY(100%) → 0`,
  `--a-dur-sheet --a-ease-sheet`; exit `--a-dur-base --a-ease-in-out`. Swipe-down on the grabber
  area may dismiss, but the close button always exists.
- **Desktop: centered dialog.** Width min(520px, 100% - 32px), radius `--a-r-lg`, enter
  `opacity 0 → 1` + `scale(.98) → 1` `--a-dur-base`. Scrim `--a-scrim`.
- **Confirm dialog** (destructive): title (title-2), one sentence body, buttons right-aligned
  (desktop: Cancel secondary on the left, action on the right) / stacked full-width (phone: action
  on top, Cancel below it). Focus starts on Cancel for destructive confirms.
- **Action sheet** (phone `…` menus): a sheet with 56 px rows (icon 22 + label 17), danger row last
  after a divider, and a separate "Cancel" button. Desktop: popover menu anchored to the trigger,
  radius `--a-r-md`, `--a-shadow-3`, rows 40 px, scale-in from the trigger corner (0.96 → 1).

### 7.14 Toasts — `.a-toast`

Bottom-center, above the tab bar/composer (`bottom: calc(tabbar + safe + 12px)`), max-width 420,
`--a-toast-bg` / `--a-toast-ink`, radius `--a-r-md`, `--a-shadow-3`, 15/22, padding 12 16. Optional
action ("Undo") in `--a-toast-action` 600. One at a time; 4 s (6 s with an action); pause on hover
or focus. Levels from `ctx.toast(text, level)`: `info` (no icon), `warn` (honey icon), `error`
(danger icon). Container `role="status" aria-live="polite"`; errors use `role="alert"`.

### 7.15 Connection banner — `.a-banner`

Top of content (below header), `--a-honey-soft` / `--a-honey-on-soft`, 40 px, caption 600, small
spinner: "Reconnecting…". After 15 s: "Can't connect right now. We'll keep trying." with a
"Try now" ghost button. Slides down `--a-dur-base`. Disappears with a 2 s "Back online" moss state.

### 7.16 Empty states — `.a-empty`

Centered block, max-width 320, padding 48 top: optional 48 px emoji or icon in a 72 px
`--a-bg-sunk` circle, title-2 Fraunces line, one callout sentence in `--a-ink-2`, one button
(primary if it's the screen's main action, otherwise secondary). No illustrations, no jokes.

### 7.17 Skeletons — `.a-skeleton`

Shapes match the final layout exactly (avatar circles, 2 text bars at 60% / 40% width, card
heights). Background `--a-skeleton`, pulse to `--a-skeleton-hi` over `--a-dur-shimmer` ease-in-out
infinite (only with `prefers-reduced-motion: no-preference`). Show skeletons only if data takes
> 300 ms (avoid flash); `aria-busy="true"` on the region. Never a full-page spinner.

### 7.18 Header / tab bar / sidebar

- `.a-header`: sticky top, height `--a-header-h` + `--a-safe-top` padding, `--a-bar-bg` +
  `backdrop-filter: var(--a-blur-bar)`, hairline bottom border appears only after scrolling (toggle
  `.is-scrolled` via an IntersectionObserver sentinel). Title centered 17/600 on phone when the large
  title has scrolled away (large title in content, iOS style); left-aligned on desktop.
- `.a-tabbar`: fixed bottom, height `--a-tabbar-h` + `--a-safe-bottom`, same translucent bar, 3 equal
  `<a>` items, icon 24 + label 12/16 600, `aria-current="page"` on the active one.
- `.a-sidebar`: see §4.4.

### 7.19 Inputs — `.a-field`

Label above (14/600 `--a-ink-2`), control 48 px tall (textarea min 96), `--a-surface` in cards /
`--a-bg-sunk` on the page, 1 px `--a-line-strong`, radius `--a-r-sm`, inset shadow. Focus: border
`--a-focus` + the focus ring. Error: border `--a-danger`, message below in `--a-danger` 14 px with
an icon, `aria-describedby`, `aria-invalid`. Placeholders end with "…".

---

## 8. Foundations (token reference)

### 8.1 Typography

**Pairing:** **Fraunces** (display) + **Figtree** (UI/body). Both are free on Google Fonts.
- Fraunces is a soft "wonky" old-style serif with an optical-size axis; at `SOFT 60` its terminals
  round off, which reads warm and human rather than corporate. Used only ≥ 20 px: greeting, screen
  titles, sheet titles, empty-state titles, space names on cards, markdown h1/h2.
- Figtree is a friendly geometric sans with open shapes and large x-height: very legible at 13–17 px
  on phones and it ships **tabular figures** (`tnum`, verified) for money and times.
- Avoided on purpose: Inter/Roboto/system-only (generic), Space Grotesk (overused), the old app's
  Nunito (cartoon sibling).

Load once in the `/app` page `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,400..650,0..100&family=Figtree:wght@400..700&display=swap">
```

Fallbacks are in the tokens (`Iowan Old Style`, `Palatino`, `Georgia` / `-apple-system`, `Segoe UI`).

| Token | Size / line | Family / weight | Use |
|---|---|---|---|
| display | 34/40 | Fraunces 500, -0.015em | Home greeting (30/36 under 360 px) |
| title-1 | 28/34 | Fraunces 500 | screen titles (Chats, Settings, space name) |
| title-2 | 22/28 | Fraunces 500 | sheet titles, empty states, "What the team knows" |
| title-3 | 17/24 | Figtree 600 | section headers, row titles |
| body | 16/24 | Figtree 400 | default, bubbles, inputs (never < 16 in inputs) |
| reading | 17/27 | Figtree 400 | memory summary, long markdown, reports text |
| callout | 15/22 | Figtree 400–500 | subtitles, previews |
| small | 14/20 | Figtree 500–600 | small buttons, chips |
| caption | 13/18 | Figtree 500 | timestamps, meta, badges |
| overline | 12/16 | Figtree 600, +0.06em, uppercase | group labels in settings/sheets only |

Rules: max 3 sizes per component; hierarchy from weight + ink level before size; body measure
45–75 characters (68ch max for reading); `text-wrap: balance` on headings, `pretty` on paragraphs;
use real typographic characters (’ “ ” … — ·); numbers that change use `.a-num`.

### 8.2 Color

One accent (clay), three quiet status hues, warm neutrals. Every text pair below was measured
(WCAG 2 relative luminance).

**Light**

| Token | Hex | Notes |
|---|---|---|
| `--a-bg` | `#F6F3EE` | oat paper |
| `--a-bg-sunk` | `#EFEAE2` | sidebar, tracks, wells |
| `--a-surface` | `#FFFFFF` | cards, sheets |
| `--a-line` / `-strong` | `#E7E1D8` / `#D6CDC0` | hairlines / inputs |
| `--a-ink` | `#23201C` | 14.6:1 on bg |
| `--a-ink-2` | `#5C554C` | 6.6:1 on bg |
| `--a-ink-3` | `#6E665B` | 5.1:1 on bg, 4.7:1 on sunk |
| `--a-ink-4` | `#A69E92` | disabled/decorative only (2.4:1) |
| `--a-clay` | `#B4532A` | fills; white text 5.0:1; as a focus ring 4.5:1 on bg |
| `--a-clay-text` | `#9A4422` | clay text/links 5.9:1 on bg |
| `--a-clay-soft` / `-on-soft` | `#F8E7DC` / `#8A3D1D` | 6.3:1 |
| `--a-lake` (working) | `#2F6690` | 6.1:1 on white; soft `#E4EDF5`, on-soft `#2A5B80` 6.1:1 |
| `--a-moss` (finished) | `#35704A` | 5.9:1 on white; soft `#E3EFE6`, on-soft `#2F6442` 5.9:1 |
| `--a-stone` (resting) | `#8E867B` | dot only; soft `#EEEAE4`, on-soft `#5C554C` 6.1:1 |
| `--a-honey` (heads-up) | `#B7791F` | soft `#FBEFD2`, on-soft `#8A5A00` 5.2:1 |
| `--a-danger` | `#B3243B` | 6.5:1 with white |

**Dark** (warm charcoal, never pure black; clay fills get darker, clay text gets lighter)

| Token | Hex | Notes |
|---|---|---|
| `--a-bg` | `#161412` | |
| `--a-bg-sunk` | `#110F0E` | |
| `--a-surface` / `-raised` | `#211E1B` / `#2A2622` | lightness steps instead of shadows |
| `--a-line` / `-strong` | `#322D28` / `#433D36` | |
| `--a-ink` | `#F3EEE7` | 15.9:1 |
| `--a-ink-2` | `#BDB5AA` | 9.1:1 on bg |
| `--a-ink-3` | `#A0978B` | 6.4:1 on bg, 5.2:1 on raised |
| `--a-clay` | `#A84E28` | `#FFF7F0` text on it 5.2:1 |
| `--a-clay-text` | `#E0805A` | 6.5:1 on bg; also the focus ring |
| `--a-clay-soft` / `-on-soft` | `#3A2419` / `#F2A283` | 7.1:1 |
| `--a-lake` / `--a-moss` / `--a-danger` | `#7FB0DA` / `#86C29A` / `#C23A50` | status text ≥ 6.9:1 on surface |

Rules: no raw hex in component CSS; clay is never decorative; status never by color alone;
per-space and per-teammate colors appear only as tints (`--a-tint` 16% light / 22% dark via
`color-mix`) behind emoji, never as text or big fills; `prefers-contrast: more` strengthens lines
and tertiary ink (already in tokens). Set `<meta name="theme-color">` for light and dark:

```html
<meta name="theme-color" content="#F6F3EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161412" media="(prefers-color-scheme: dark)">
```
(When the user picks Light/Dark explicitly, replace both with one tag holding `--a-theme-color`.)

Theme wiring: `<html data-theme="auto">` by default; read `localStorage["hearth.theme"]` in an
inline script in `<head>` **before** CSS paints to avoid a flash.

### 8.3 Spacing

4 px base: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80 (`--a-s-half` … `--a-s-20`).
- Page gutter 20 (phone) / 32 (desktop). Section gap 32 (phone) / 40 (desktop). Title → content 16.
- Inside cards/rows 12–16; between related items 8; between groups 24.
- Breathe unevenly: dense rows, then open section breaks. Don't space everything the same.

### 8.4 Radius

6 (chips) · 10 (small buttons, inputs, thumbnails) · 14 (buttons, groups, segmented) · 20 (cards,
bubbles, dialogs) · 28 (sheet top, composer field) · pill (avatars, badges, send). Nested elements:
inner radius = outer radius − padding (concentric).

### 8.5 Elevation (one strategy: soft warm shadows in light, lightness steps + hairline in dark)

- `--a-shadow-1`: resting cards, groups, selected segment.
- `--a-shadow-2`: hover on interactive cards, floating "New message" pill.
- `--a-shadow-3`: sheets, dialogs, popovers, toasts.
- Bars (header, tab bar, composer) are translucent (`--a-bar-bg` + blur) with a hairline, not shadows.

### 8.6 Iconography

- **Inline SVG, stroke icons**, 24 × 24 viewBox, `stroke-width="1.75"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`, `fill="none"`, `stroke="currentColor"`, rendered at 20–24 px,
  `aria-hidden="true"` (the button carries the label).
- Source: **Lucide** (ISC license; lucide.dev). Copy the inner SVG markup for only the icons we use into
  `src/client/app/icons.ts` as `Record<IconName, string>` and render with a tiny `icon(name, size)`
  helper. No icon font, no runtime dependency.
- The set (the app's name → Lucide name): home `house` · chats `message-circle` · settings `settings` ·
  back `chevron-left` · forward `chevron-right` · add `plus` · attach `paperclip` · photo `image` ·
  file `file-text` · send `arrow-up` · more `ellipsis` · close `x` · check `check` · light `sun` ·
  dark `moon` · auto `sun-moon` · notes `book-open` · reports `chart-column` · team `users` · group chat
  `messages-square` · wake `sunrise` · rest `moon-star` · behind the scenes `eye` · open external
  `arrow-up-right` · remove `trash-2` · retry `rotate-cw` · offline `cloud-off` · sign out `log-out` ·
  download `download` · warning `triangle-alert` · info `info`.
- A few paths to start (Lucide geometry): chevron-left `<path d="m15 18-6-6 6-6"/>`, plus
  `<path d="M5 12h14"/><path d="M12 5v14"/>`, x `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  check `<path d="M20 6 9 17l-5-5"/>`, arrow-up `<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`.
- **Emoji only where they're data**: teammate avatars (roster emoji) and space tiles (department
  icon, e.g. 🏡 💵). Never emoji as UI icons (buttons, tabs, menus).

### 8.7 Motion

Felt, not watched. Tokens: instant 90 ms (press) · fast 150 ms (hover, color, exits) · base 220 ms
(items, chips, toasts, popovers, dialog) · slow 320 ms (screen push) · sheet 380 ms.
Easing: `--a-ease-out` for anything arriving or responding; `--a-ease-in-out` for things moving
across the screen; `--a-ease-sheet` for sheets; `--a-ease-in` only for short exits.

| Moment | Motion |
|---|---|
| Push screen (phone) | new: `translateX(var(--a-push))` → 0 + opacity 0 → 1, slow, ease-out; back: base |
| Switch tab / segment | content crossfade, fast; segment pill slides, base |
| Desktop route change | content fade + rise 8 px, base |
| List appears | items fade + rise 8 px, stagger 40 ms, first 6 only |
| New message | fade + rise 8 px, base |
| Sheet | rise from bottom, sheet/ease-sheet; exit base |
| Dialog / popover | opacity + scale .98 (.96 for popover, from trigger corner), base |
| Button press | scale .97, instant |
| Working ring | opacity breathe, 2.8 s, infinite |
| Becomes "needs you" | single 600 ms pulse on the avatar |
| Toast | rise 8 px + fade in base, fade out fast |

Rules: animate only `transform` and `opacity`; never `transition: all`; animations are
interruptible; exits are faster than entrances; nothing longer than 400 ms except loops; one
loop per screen at most (the rings). **Reduced motion:** tokens already zero out `--a-rise`,
`--a-push`, `--a-press-scale`, `--a-stagger` and shorten durations; loops must be wrapped in
`@media (prefers-reduced-motion: no-preference)`; the base layer is the safety net.

---

## 9. Microcopy

**Glossary (system word → the app's word).** These system words must never reach the screen:

| System | In the app |
|---|---|
| floor / project | space |
| worker / agent / desk | teammate |
| hire / spawn | add |
| crew | crew (a group of teammates you add together) |
| session / terminal / PTY | chat · "Behind the scenes" for the raw view |
| prompt / input | message |
| needs_input / permission | needs you · wants your OK |
| done | finished |
| exited / offline | resting |
| resume / restart | wake |
| kill / fire | remove from space · let them rest |
| meeting | group chat |
| memory / MEMORY.md / log | what the team knows · notes |
| worktree, branch, PR, model, tokens | never shown |

**Voice:** sentence case everywhere (buttons too: "Add teammates", not "Add Teammates"); use the
teammate's name; contractions; no exclamation marks, anywhere. Numbers as digits. Times: "just now", "5 min ago", "2:14 PM", "Yesterday", "Mon", "Sep 22".
Money: "$1,240.50", negatives "−$32.00" (true minus). Ellipsis `…`, curly quotes, non-breaking
space in "1.2&nbsp;MB".

**Example strings**

- Home: "Good morning, Sam." · "Meal Planner needs you. Everyone else is humming along." ·
  "You're all caught up." · "Your spaces"
- Space: "4 teammates · 1 needs you" · "Group chat" · "Add teammates" · "Wake everyone"
- Status: "Needs you" · "Working on it" · "Finished" · "Ready" · "Resting" · "Getting settled…"
- Chat: "Message Meal Planner…" · "Reply to Meal Planner…" · "Thinking…" · "Needs your OK" ·
  "Resting — send a message to wake them" · "Sending…" · "Didn't send · Tap to retry" ·
  "New message" · "Behind the scenes"
- Ask: "Wants your OK" · "Yes, go ahead" · "No" · "Reply instead"
- Notes: "What the team knows" · "Recent notes" · "Files" · "Show older"
- Reports: "Made by Household Accountant · Sep 28" · "Open in a new tab"
- Add: "Add teammates" · "Pick a crew, or one person." · "Add 3 teammates" · "Already here" ·
  "3 teammates are joining Home Life"
- Group chat: "Start a group chat" · "Who's joining" · "What's it about?" · "Pick at least two people"
- Settings: "Choose which spaces show up." · "Light" · "Dark" · "Auto" · "Signed in as Sam" ·
  "Sign out"
- Errors: "Couldn't send that. Tap to try again." · "Can't connect right now. We'll keep trying." ·
  "That file is too big — try one under 20 MB." · "Something went wrong on our side. Try again in a
  moment." Never show stack traces, status codes, or server messages.
- Confirm remove: "Remove Garden Helper from Home Life?" / "They'll stop what they're doing. Their
  notes stay with the team." / "Remove" · "Cancel"

---

## 10. Accessibility (WCAG 2.2 AA, plus a few AAA habits)

- Contrast: text ≥ 4.5:1 (large ≥ 3:1), UI boundaries/icons/focus ≥ 3:1 — all tokens are
  pre-checked (§8.2). `--a-ink-4` is for disabled/decorative only.
- Focus: visible 2 px clay ring + 2 px offset on every focusable (`:focus-visible`), never removed;
  sticky header/tab bar/composer must not hide the focused element (2.4.11) — `scroll-padding` is set
  in the base layer; sheets trap focus via `<dialog>`.
- Targets: 44 × 44 minimum everywhere (exceeds 2.5.8's 24 px; matches Apple 44 pt), 8 px between
  adjacent targets. Small visuals get a larger hit area via padding or `::before`.
- Dragging (2.5.7): swipe-to-dismiss and drag-and-drop always have a button alternative.
- Status never by color alone: text labels + ring/dot shape.
- Semantics: one `<h1>` per screen (the screen title); landmarks `<nav>` (tab bar/sidebar),
  `<main>`, `<header>`; chat log `role="log" aria-live="polite"`; status line `aria-live="polite"`;
  toasts `role="status"`; segmented = tablist/radiogroup; switches `role="switch"`; icon buttons
  `aria-label`; avatars `aria-hidden`; badges folded into accessible names.
- Keyboard: every action reachable by Tab; Esc closes sheets/menus; arrow keys in segmented controls
  and menus; Enter/Shift+Enter in the composer (desktop).
- Text resize: sizes in rem; layouts reflow at 200% zoom and 320 px width without horizontal scroll
  (except inside tables/code).
- Motion: honor `prefers-reduced-motion` (tokens + base layer). Contrast: honor `prefers-contrast`.
- Language: `<html lang="en">`; images from teammates need `alt` (use file name if nothing else).
- Redundant entry (3.3.7): drafts and group-chat picks survive navigation.

---

## 11. Phone specifics

- Viewport: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`
  (no `maximum-scale`; never block zoom).
- Safe areas: header adds `--a-safe-top`; tab bar/composer/sheet footers add `--a-safe-bottom`;
  side padding `max(var(--a-gutter), var(--a-safe-left/right))` for landscape.
- Heights: use `100dvh` (with `100vh` fallback), never `100vh` alone.
- Thumb reach: primary actions live in the bottom 40% (tab bar, composer, sheet footers). The only top
  controls are Back and `…`.
- **Keyboard + composer (the hard part):**
  - Chat screen is a fixed full-height grid: `header / log (scroll) / composer`. The log is the only
    scroller (`overscroll-behavior: contain`), so the page itself never scrolls.
  - Android Chrome: `interactive-widget=resizes-content` shrinks the layout viewport, so `dvh` just
    works.
  - iOS Safari ignores it (as of 2026 it's in WebKit source but not shipped); use `visualViewport`:
    on `resize`/`scroll`, set the chat root's `height = visualViewport.height` px and
    `transform: translateY(visualViewport.offsetTop px)`, and set `--a-kb` =
    `innerHeight - visualViewport.height`. When `--a-kb > 80` add `body.kb-open`, which drops the
    composer's safe-area bottom padding to 8 px. Then scroll the log to the bottom if she was there.
  - Keep the composer field ≥ 16 px (prevents iOS focus zoom). Blur doesn't happen on send (keyboard
    stays up for the next message).
  - Tapping the log while the keyboard is up does not dismiss it; a downward scroll of the log
    (`touchmove` > 24 px) does (`textarea.blur()`), like Messages.
- Add to Home Screen: provide a web manifest (`name: "Agent Express"`, `display: "standalone"`,
  `background_color`/`theme_color` #F6F3EE) and a 180 px `apple-touch-icon` (clay dot on oat) so
  Sam can launch it like an app; standalone mode makes the safe-area handling above essential.
- Hover styles only under `@media (hover: hover)` (no sticky hover on touch).
- Long-press is never required for anything.

---

## 12. Engineering notes (plain TS + DOM)

- CSS files: `tokens.css` (this system, owned by Design) → `app.css` (layout shell) → one CSS file per
  component family. Import tokens first.
- Class naming `a-block`, `a-block__part`, `a-block--variant`, states as `is-*` or ARIA attributes
  (`[aria-selected="true"]`, `[aria-current="page"]`, `[data-status="needs"]`); style by ARIA where
  possible so a11y and visuals can't drift apart.
- Per-element colors: `h('span.a-avatar', { style: `--a-who:${w.color}`, 'data-status': s, 'data-size': 48 })`.
- Build list rows as `<a href="#/chat/...">` (real links: middle-click, back button) or `<button>`
  for in-place actions.
- Don't measure layout in JS except the `visualViewport` keyboard fix and the scroll-to-bottom logic.
- Screens render skeletons synchronously, then fill; keep DOM keyed by worker id so status updates
  patch rows instead of re-rendering the list (no flashing, no scroll jumps).
- Test widths: 320, 375, 390, 430 (phones), 768 (tablet), 1280 and 1600 (desktop), both themes,
  200% zoom, reduced motion on.

### Pre-ship checklist (per screen)

- [ ] One primary action (or the list is the action); nothing else is clay.
- [ ] No system words (§9 glossary).
- [ ] Every status has text; rings match §5.
- [ ] All states: hover (hover-capable only), active, focus-visible, disabled, loading, empty, error.
- [ ] Skeleton matches final layout; no layout shift.
- [ ] 44 px targets, focus not obscured, keyboard path works, Esc closes overlays.
- [ ] Light, dark, and auto all correct; no raw hex in the component CSS.
- [ ] 320 px wide and 200% zoom: no horizontal page scroll.
- [ ] Reduced motion: nothing travels or loops.
- [ ] Squint test: the one thing she came for is the most prominent thing.

---

## 13. Research basis (what we followed and why)

1. **Commit to a specific aesthetic direction and execute it precisely; avoid generic defaults
   (Inter/Roboto/system fonts, purple-on-white gradients, cookie-cutter layouts). Refined
   minimalism works when it's intentional.** — Anthropic `frontend-design` skill (installed locally;
   also in [anthropics/skills](https://github.com/anthropics/skills)) and the cookbook
   [Prompting for frontend aesthetics](https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb)
   (distinctive display + refined body font, strong weight contrast, CSS variables, dominant color
   with a sharp accent, one orchestrated entrance over scattered effects).
2. **A theme is a named, cohesive palette + font pairing applied consistently, with contrast
   checked.** — Anthropic `theme-factory` skill. `web-artifacts-builder` adds: avoid excessive
   centered layouts, purple gradients, uniform rounded corners and Inter.
3. **Decide the design system once and write it down (tokens, spacing grid, one depth strategy,
   radius scale, four text levels, one accent); check with swap/squint/signature/token tests.** —
   [interface-design skill](https://github.com/Dammyjay93/interface-design) and the comparison at
   [softwarethug.com](https://www.softwarethug.com/posts/claude-code-ui-design-skills-compared/).
4. **Priority order for UI rules: accessibility and touch first (4.5:1, 44 × 44, 8 px gaps), then
   performance, style consistency, responsive layout, type (16 px / 1.5), motion; SVG icons, not
   emoji, as UI icons; ≤ 5 bottom-nav items.** — [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill).
5. **Hierarchy from weight and color before size; design in grayscale first; constrained scales for
   spacing, type, shadows; 8–10 greys, not true black.** — Refactoring UI (Wathan & Schoger),
   [summary](https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/) and the
   [refactoring-ui skill](https://github.com/LovroPodobnik/refactoring-ui-skill).
6. **Interface details: ≥ 16 px inputs on iOS, 44 px mobile hit areas, focus-visible rings, never
   `transition: all`, animate transform/opacity, optimistic updates with rollback, skeletons that
   mirror content, tabular numbers, curly quotes and `…`, `color-scheme` + `theme-color`, layered
   shadows, concentric radii, don't autofocus on mobile.** —
   [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines).
7. **Motion: UI transitions under 300 ms, ~200 ms ease-out is the default, exits faster than
   entrances, custom ease-out curves, press scale ~0.97, never scale from 0.** —
   [Emil Kowalski, 7 practical animation tips](https://emilkowal.ski/ui/7-practical-animation-tips)
   and his [skills repo](https://github.com/emilkowalski/skills).
8. **WCAG 2.2 AA additions that matter here: 2.5.8 target size (24 px minimum, 44 px recommended),
   2.4.11 focus not obscured (sticky bars), 2.5.7 dragging alternatives, 3.3.7 redundant entry.** —
   [W3C Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
   [TetraLogical: what's new in 2.2](https://tetralogical.com/blog/2023/10/05/whats-new-wcag-2.2/).
9. **Touch targets: Apple 44 pt, Material 48 dp, WCAG AAA 44 px.** —
   [LogRocket: accessible touch target sizes](https://blog.logrocket.com/ux-design/all-accessible-touch-target-sizes/).
10. **Mobile keyboard: `interactive-widget=resizes-content` works on Android Chrome; iOS Safari
    still needs `visualViewport` tracking.** —
    [HTMHell: interactive-widget](https://www.htmhell.dev/adventcalendar/2024/4/),
    [bramus explainer](https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md),
    [VisualViewport fix](https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a).
11. **shadcn/Radix practice, translated to plain DOM: semantic token pairs (background/foreground,
    primary/primary-foreground) instead of raw colors; native elements first, headless-primitive
    behavior (focus trap, Esc, ARIA, roving focus) when hand-rolling.** —
    [shadcn/ui theming](https://ui.shadcn.com/docs/theming), [Radix Primitives](https://www.radix-ui.com/primitives).
    We get most of it free from `<dialog>`, `<button>`, `<input type=checkbox role=switch>`.
