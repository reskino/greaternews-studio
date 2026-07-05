# Update Log

## 1.3.0 - 2026-07-05
- Rebuilt "Find images for the selected story" after it returned irrelevant results. It now: extracts the people/places/organizations from the headline (instead of mashing all words into one query), pulls each entity's Wikipedia lead image (the canonical photo, license-verified against Commons so fair-use files are excluded), searches Commons and Openverse per entity, and ranks results by relevance.
- Added a Ghana acronym dictionary (BoG → Bank of Ghana, GFA, ECG, COCOBOD, NPP/NDC, etc.) so abbreviations resolve to the right entity — "BoG" previously matched "Bog", the swamp.
- Added steer-the-search chips: after an auto-search, each extracted entity is a clickable chip to rerun that query alone.
- Verified against real headlines: the Bank of Ghana jobs story now returns BoG headquarters and the Accra skyline; the Tourism Authority story returns the Ministry of Tourism logo and Ghana tourism sites.

## 1.2.0 - 2026-07-05
- Posted log backup and restore: "Backup (JSON)" downloads the full log; "Import backup" merges a backup file in (duplicates skipped) — protects the never-repeat history from browser data loss.
- Engagement tracking: each logged post now has reach / reactions / shares fields; once 3+ posts have numbers, an Audience Insight callout shows the best-performing category.
- Recap card one-click fill: "Fill from this week's log" drops the week's logged headlines and date range straight into the Week in Review template.
- Google News fallback titles no longer carry the trailing "- Outlet" suffix.
- Deployed live to https://reskino.github.io/greaternews-studio/ (public repo github.com/reskino/greaternews-studio).

## 1.1.0 - 2026-07-05
- Feed reliability: every source now has a three-step fallback — direct feed via rss2json, then that outlet's stories via Google News RSS, then the raw feed XML through a CORS proxy with our own RSS/Atom parser. Fixes the failing GhanaWeb / Citi Newsroom / Al Jazeera feeds.
- Added "Copy Claude brief" in the draft step: packages the selected story plus all house rules into one prompt for Claude, which verifies the story and writes the entire pack.
- The app is now an installable PWA: manifest, brand icons generated from the logo, and a network-first service worker so it opens on flaky connections.
- Relative build paths (works at any URL) and the logo now loads correctly under a subpath.

## 1.0.1 - 2026-07-04
- Rebranded the tagline from "Ghana to the World" to "News You Can Trust" across the app (card handle strip, top bar, video script CTA), the master prompt, and the unposted launch content, including the #NewsYouCanTrust hashtag.

## 1.0.0 - 2026-07-04
- Full restructure: the app is now a 5-step editorial pipeline — Story desk → Draft & verify → Outputs → Card Studio → Publish & track — matching the real daily workflow.
- Removed everything decorative or redundant: the hero banner, the story spotlight poster, the History Today section, and the footer filler (about 300 lines of dead CSS with them).
- Replaced the hero with a slim top bar: brand, version, date, Copy pack, and Save pack in one row.
- Editorial guardrails collapsed into a compact expandable checklist inside the draft step.
- Codebase split into focused modules: types.ts, text.ts, feeds.ts (sources + fetching + story selection), outputs.ts (post builders + pack export), usePostedLog.ts (persistence + follow-ups); App.tsx dropped from ~1,300 lines to ~430 of pure composition.
- All behavior preserved: live feeds, POSTED badges, auto-skip in Auto mode, copy buttons, X character counter, Card Studio with five templates and image search, follow-up reminders, pack/log export.

## 0.8.0 - 2026-07-04
- Added the story-aware image finder: "Find images for the selected story" extracts the people and places from the headline (plus a category fallback), runs multiple licensed-image searches at once, and shows a deduplicated result grid.
- Search results are capped and deduplicated across Wikimedia Commons and Openverse.
- Moved chip colors from inline styles to CSS classes.
- First real editorial pack shipped to /content: verified own-angle story on the Cape Town killing and evacuations, plus account-launch content and a first-week playbook.

## 0.7.0 - 2026-07-04
- Card Studio now has five templates: Headline, Quote (attributed statement), Update (UPDATE/DEVELOPING/BREAKING banner), Stat (big number), and Recap (week in review, up to five headlines).
- The real GreaterNews logo (public/logo.png) now renders in the card badge, replacing the drawn monogram.
- "Download all sizes" exports portrait 4:5, square 1:1, and story 9:16 PNGs in one click.
- Added a photo darkness slider (0–80%) for tuning bright photos on somber stories.
- Every card carries an editable handle strip ("@GreaterNews · Ghana to the World") plus the credit line.
- New "Awaiting follow-up" panel: logged DEVELOPING stories stay listed until marked updated — powering the own-the-story strategy.
- Refactored into a pure card engine (src/cardEngine.ts) and image search module (src/imageSearch.ts); Card Studio state can be seeded from URL params for deep-linking and testing.
- Master prompt Section 5F now lists the card templates and the follow-up discipline rule.

## 0.6.0 - 2026-07-04
- Added photo search to the Card Studio: search Wikimedia Commons and Openverse for free-to-use, CC-licensed images without leaving the app.
- Clicking a result loads it straight onto the card and auto-fills the photo credit line (author · license · provider); a "View source & license" link stays attached to the loaded photo.
- Images load with CORS-safe fallbacks so the PNG export keeps working with searched photos.
- Master prompt now documents approved photo sources and the attribution rule.

## 0.5.0 - 2026-07-04
- Added the Card Studio: an in-app designer that turns any story into a branded news-card image (photo blending into black, GREATERNEWS strip, bold centered headline with a gold highlight phrase, GN logo badge).
- Upload a photo, type the headline and highlight phrase, pick a format (portrait 4:5, square 1:1, story 9:16), then download the PNG or copy it straight to the clipboard.
- "Use selected story" prefills the card from the story currently loaded in the editor.
- News Card output and master prompt Section 5F now include the highlight phrase and the house design spec.
- Added Poppins for card typography.

## 0.4.0 - 2026-07-04
- Upgraded the master prompt to v2.0: session start protocol, verification ladder (REPORTS/DEVELOPING/FACT CHECK), weekly rhythm, news card format, corrections protocol, pre-publish checklist, and expanded commands.
- Replaced the dead Reuters RSS feeds with working Al Jazeera, BBC Africa, and France 24 feeds so live stories load again.
- Added per-output Copy buttons and a live 280-character counter on the X post.
- Added a News Card (design handoff) output to the app and the exported day pack.
- Story menu now flags already-logged stories with a POSTED badge, and Auto mode skips them so stories never repeat.
- Output formats now follow the master prompt more closely: category-specific hashtags, DEVELOPING prefixes, and a timed HOOK/STORY/CTA video script.
- Live feed status now names any feeds that failed to load; feeds fetch once on load instead of on every mode change.
- Cleaned up duplicated draft-clone helpers.

## 0.3.5 - 2026-07-04
- Added per-item timestamps to History Today so logged stories read like a timeline.
- Styled the history entries with a clearer left-rail timeline treatment.
- Kept the existing workflow and export structure intact.

## 0.3.4 - 2026-07-04
- Refined the History Today section into a more newspaper-like ledger.
- Strengthened the stats, item cards, and empty-state presentation.
- Fixed the mobile CSS override so the layout stays responsive.

## 0.3.3 - 2026-07-04
- Added a History Today section under the spotlight to track today's logged stories.
- Included quick daily stats and empty-state guidance for the current date.
- Kept the existing menu, spotlight, and export workflow intact.

## 0.3.2 - 2026-07-04
- Refined the story spotlight into a taller poster-style composition.
- Strengthened the headline hierarchy and image-like treatment to better match the example.
- Kept the existing live feed, menus, and social output workflow intact.