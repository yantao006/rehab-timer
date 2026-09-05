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
The same scoreboard shows the preparation countdown before any repetition becomes active.
The outer width is capped at 920px with responsive gutters and safe-area padding.

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

Two labeled rows of six split-time cells map the prescribed two-group session exactly.
Completed cells turn pool teal, the active work cell turns orange and grows vertically, and pending cells remain foam white.
A repetition becomes complete as soon as its work interval ends, including during the following short rest and during group rest.

### Skip Prep Button

During the 30-second preparation window only, a teal pill labeled 「跳过准备」 sits beside Reset.
It is hidden once the first work cue begins.
It uses pool teal, never orange or danger red.

### Reset Button

The persistent running control is a white pill labeled 「停止并重置」 in danger red.
Its wording combines interruption and recovery so there is no ambiguous paused state.

## Do's and Don'ts

### Do:

- **Do** preserve orange for Start and the active repetition.
- **Do** keep the fixed two-by-six lane visible whenever the session is running.
- **Do** use solid fields and high contrast so the optional screen remains glanceable.
- **Do** preserve the authored scoreboard reveal and reduced-motion fallback.

### Don't:

- **Don't** replace the scoreboard with a circular progress ring.
- **Don't** add decorative cards, coaching claims, achievements, or gamification.
- **Don't** add network-dependent fonts, images, icons, or effects.
- **Don't** let visual animation compete with the spoken cue and beep sequence.
