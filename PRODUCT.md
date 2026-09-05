# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static, self-contained HTML, CSS, and JavaScript in `index.html`.
This was explicitly specified in the launch brief.

## Users

The primary user is completing a rehabilitation exercise session and cannot reliably look at the screen while training.
This is inferred directly from the launch brief because the worker session is explicitly unattended.

## Product Purpose

The product runs one fixed rehabilitation session with a single Start action, then makes voice cues and clock-zero beeps sufficient to complete the session without looking at the screen.
Success means the user can follow the 30-second preparation window and every work, short-rest, group-rest, and completion transition by sound alone.

## Positioning

Unlike a generic interval timer, this timer encodes one prescribed two-group rehabilitation sequence and makes the spoken-cue-then-beep boundary the authoritative start of every interval.

## Operating Context

The page is opened locally with no account or network connection.
The phone remains unlocked, the page stays in the foreground, and Screen Wake Lock is requested when available.
The user may glance at a large countdown, but audio remains the complete operating channel.

## Capabilities and Constraints

A session begins with 「准备，30秒」, a clock-zero beep, and a 30-second preparation window before the first work cue.
The preparation window can be skipped with one tap; the first work cue still plays after the skip.
It then has two groups of six repetitions.
Each repetition has 15 seconds of work followed by 5 seconds of rest, except that group 1 repetition 6 goes directly from work to a 60-second group rest and group 2 repetition 6 ends the session immediately after work.
Chinese Web Speech Synthesis speaks every cue.
A Web Audio oscillator beep marks interval zero after its cue.
All interval boundaries are calculated from the first beep rather than chained timers.
The page has no framework, build system, accounts, network requests, analytics, or deployment.

## Brand Commitments

The voice is short, direct, and supportive without adding unrequested coaching language.
The locked Chinese cue copy in the launch brief must remain exact.

## Evidence on Hand

The launch brief is the only source of product truth.
There are no customer claims, brand assets, research results, or performance claims to fabricate.

## Product Principles

Audio is the primary interface, and the screen is a resilient secondary channel.
One tap must be enough to unlock and start the experience.
Clock boundaries must be deterministic and auditable.
The fixed prescription must not acquire extra rests or extra cues.
The local page must remain understandable and usable without setup.

## Accessibility & Inclusion

Controls must remain keyboard operable and visibly focused.
Status changes must be exposed as text without making screen-reader announcements compete with the spoken training cues.
Motion must respect reduced-motion preferences.
