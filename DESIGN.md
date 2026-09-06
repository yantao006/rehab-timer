---
name: 康复训练计时器
description: A voice-first rehabilitation timer shaped like an aquatic therapy pace board.
colors:
  pool: "#087e8b"
  pool-deep: "#07324a"
  pool-dark: "#041f32"
  water: "#bde8e5"
  foam: "#f7fbf9"
  tile: "#eaf4f3"
  signal: "#f36a32"
  signal-dark: "#8c2d10"
  ink: "#08283c"
  muted: "#3e5d68"
  line: "#9bcac9"
  danger: "#a32d20"
typography:
  display:
    fontFamily: "Kaiti SC, STKaiti, KaiTi, serif"
    fontSize: "clamp(2.55rem, 7vw, 5.4rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  measurement:
    fontFamily: "Avenir Next Condensed, DIN Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(5rem, 21vw, 6rem)"
    fontWeight: 800
    lineHeight: 0.82
    letterSpacing: "-0.04em"
rounded:
  control: "999px"
  panel: "26px"
  calendar: "8px"
spacing:
  compact: "12px"
  standard: "24px"
  generous: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.pool-dark}"
    rounded: "{rounded.panel}"
    padding: "34px"
  button-reset:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "52px"
  scoreboard:
    backgroundColor: "{colors.pool-deep}"
    textColor: "{colors.foam}"
    rounded: "{rounded.panel}"
---

# Design System: 康复训练计时器

## Overview

**Creative North Star: "The Aquatic Therapy Pace Board"**

The interface borrows the legibility, lane markers, and decisive timing language of a pool-deck pace board.
It feels bright enough for an active training room, tactile enough for one deliberate tap, and quiet enough to disappear once audio takes over.
It rejects the generic circular progress timer in favor of a split scoreboard that keeps phase, repetition, and time immediately legible.

**Key Characteristics:**

- Chlorine tile and deep lane blue form the dominant field.
- Safety orange is reserved for the action and active repetition.
- Rope markers and split-time bars make progress physical rather than ornamental.
- One scoreboard reveal is the authored motion moment.

## Colors

The palette combines cool therapy-room surfaces with one unmistakable safety signal.
Deep pool tones carry running state and high-contrast information.
Foam and tile tones keep the idle page bright under ordinary indoor light.
Orange marks Start and the current repetition, while danger red is reserved for stopping and errors.

**The Safety Signal Rule.**
Use orange only for the primary Start action and the active training marker so it never loses urgency.

## Typography

Kai-style Chinese display lettering gives instructions a human coaching voice without importing a network font.
The system body stack handles supporting copy and controls.
Condensed tabular numerals are reserved for the countdown because they are measurement, not decoration.

**The Glance Rule.**
Phase, group, repetition, and remaining time must be understandable in one glance without reading explanatory copy.

## Layout

The page is a centered full-height lane between two rope markers.
Idle mode places the plain-language promise beside one oversized Start block on wide screens and stacks them on phones.
Running mode splits the scoreboard into a dark phase bay and a dominant clock field, then linearizes those zones below 700px.
The same scoreboard shows the initial preparation countdown before any repetition becomes active.
Five numbered stage points stay above it, followed by the unabridged exercise identity and equipment.
The next-stage ready screen keeps a stationary upcoming duration and puts the explicit continue action inside the clock field, not below the fold after the progress lanes.
The outer width is capped at 920px with responsive gutters and safe-area padding.
A quiet month calendar follows the training surface rather than competing with its countdown.

## Elevation & Depth

Most structure comes from solid color fields and one-pixel dividers.
The Start block and scoreboard alone use a soft downward ambient shadow to feel like physical equipment resting above tile.

## Shapes

Primary equipment panels use generous 26px corners.
Secondary controls and progress cells use complete pill geometry.
Circular forms appear only as partial lane-rope and equipment markings, never as progress rings.

## Components

### Start Button

The Start button is a full orange equipment block with Kai display text, an authored waveform, and a large touch target.
Hover lifts it by 3px, active press moves it down by 1px, and disabled state reduces saturation while audio initializes.

### Scoreboard

The scoreboard pairs a nearly black blue phase bay with a deep blue clock field.
The current interval owns the largest type, while the next transition remains secondary and explicit.

### Progress Lanes

Five numbered stage points express the top-level sequence; they are a non-interactive ordered list, never skip buttons.
Completed points are pool teal with an explicit completed label, the current point is orange, and pending points remain foam white.
Short progress labels supplement full accessible names and the untruncated current-stage heading.
Within stages 1-4, two labeled rows of six split-time cells map that stage's groups exactly.
Within stage 5, eight cells map four alternating work/stretch rounds.
Completed cells turn pool teal, the active action cell turns orange and grows vertically, and pending cells remain foam white.
A repetition becomes complete as soon as its work interval ends, including during the following short rest and during group rest.

### Timing Controls

During the initial 30-second preparation window only, a teal pill labeled 「跳过准备」 sits beside Pause and End.
During a 60-second group rest only, 「跳过休息」 occupies the same secondary-control vocabulary.
Neither control can skip work or short repetition rests.
Pause has a distinct stopped state and preserves the remaining interval time.
Ready and paused states place their orange Continue action inside the dark scoreboard with a foam focus outline.
The next-stage label is exactly 「准备好了，开始下一项」 and never implies an automatic start.

### End and Restart

「结束 / 重新开始」 is a white pill in danger red.
It pauses first and opens an inline confirmation, explicitly preserving saved history.
The confirmation has clear commit/cancel choices and deliberate keyboard focus.

### Calendar and Warnings

The calendar is a simple seven-column grid with Monday first, month navigation and no decorative achievement cards.
Completed dates use pool teal with white text; today has a dark outline and the word 「今天」, including on a completed date.
Multiple full sessions on a day still produce one marked date, while the weekly summary counts sessions against 3-4 per week.
Calendar marks are informational, not editable or clickable check-ins.
Storage, speech and wake-lock warnings state what failed and how to proceed without claiming success.
Local-only storage and the foreground/unlocked-phone limitation remain in the footer.

### Operate Extension Tokens

This surface is Operate mode: retain the incumbent aquatic pace-board identity, with system text for detailed exercise names, controls and the calendar.
Supporting text uses a compact 0.7-0.95rem scale; the smallest sizes are only redundant status/date labels, not the sole accessible exercise identity.
Body and detailed status use 1-1.2rem, section and exercise headings use 1.35-1.4rem, phase labels use 2.4-2.7rem, and running measurement uses 5.5-6rem.
A ready state's stationary upcoming duration is 3rem, distinct from the active countdown.
Retain the incumbent secondary shades #659da0 and #6e9da0 for dividers, #d9eeee for dark-surface text, #213b43 for Start supporting text, #d7f3f1 for teal hover and #fff3f0 for danger hover.
The orange action hover is #fa8454.
The existing generated `.impeccable/design.json` is not hand-edited; this document and shipped CSS remain the visual authority.

## Do's and Don'ts

### Do:

- **Do** preserve orange for Start and the active repetition.
- **Do** keep five non-interactive stage points visible, with the current stage's two-by-six lane or eight-action lane.
- **Do** use solid fields and high contrast so the optional screen remains glanceable.
- **Do** preserve the one-time scoreboard reveal and reduced-motion fallback.
- **Do** keep controls at least 44px high, with 52px timing actions and no horizontal overflow at 320px.

### Don't:

- **Don't** replace the scoreboard with a circular progress ring.
- **Don't** add decorative cards, coaching claims, achievements, or gamification.
- **Don't** add network-dependent fonts, images, icons, or effects.
- **Don't** let visual animation compete with the spoken cue and beep sequence.
