# GreaterNews — "Deep Dive" explainer track (build plan)

A **separate** pillar from the daily shorts: occasional (2–3× a week), high-craft, well-referenced
video explainers of the big world/Africa stories people actually want to *understand* — blending
stock b-roll + licensed images + stat cards + maps, narrated by a strong voice, and reviewed by a
human before publishing. Built to be **mastered**, not mass-produced.

## Positioning
- "Understand the world, clearly — and trust it." Not reposting headlines: explaining them with sources.
- World / Africa stories that matter globally (e.g. Strait of Hormuz). A Ghana/Africa angle strengthens
  relevance but isn't required if the story is genuinely global.
- **Follow-ups**: a big story is a *topic* that can get update episodes as it develops (a mini-series).

## Non-negotiables
1. **Verify before video** — the research brief is reviewed/approved by a human before anything renders.
2. **References always** — every claim source-tagged; on-screen "Sources" card + sources in the post.
3. **Illustrative b-roll only** — generic/atmospheric clips (a stock tanker), never footage passed off
   as the real event or people. Sensitive stories → neutral imagery, no people.
4. **Separate & occasional** — own trigger, own review queue; does not touch the daily shorts pipeline.

## Format (v1)
- 60–90s vertical (social-native). Landscape/YouTube version is a later option.
- ElevenLabs voice (synth fatigues past ~40s).
- ~7 chapters: Hook → What & where → Why it matters (global) → Why now → The numbers →
  Impact (Ghana/world) → What's next + CTA, then a **Sources** card.

## Phases

### Phase 1 — Deep-research brief  *(the foundation & the thing you review)*
- Fan out ~6 targeted searches per topic: the event, background/timeline, the numbers, stakeholders &
  quotes, impact (incl. Ghana/Africa), what's next. **Read full articles, not snippets.**
- Synthesize a structured, source-cited brief: summary · timeline · key facts (each cited) · numbers ·
  attributed quotes · why it matters / who it affects · what's next · open questions · **numbered
  References (URL + outlet + date)**.
- Verification: cross-check key numbers across ≥2 independent sources; label single-source "developing";
  add a confidence note. Best done as a multi-agent pass (fan out → read → cross-check → synthesize).
- **Review gate:** you read / edit / approve the brief. Nothing renders until you do.

### Phase 2 — Explainer script (from the approved brief)
- Chaptered 60–90s script (~180 spoken words), each chapter = short on-screen caption + fuller spoken
  line, drawn ONLY from the approved brief. Closing Sources card.

### Phase 3 — Visual track  *(the biggest new build)*
- Per chapter, pick the best visual: **Pexels b-roll** (generic, illustrative) if one fits, else a
  **licensed still** (Ken-Burns), plus **stat cards** (existing card engine) for numbers and a
  **generated map graphic** for geography.
- New pieces: Pexels video search/fetch/trim/mute; compositing video frames into the WebCodecs export;
  a simple map-graphic generator; stat-card scenes.
- Integrity rules from above enforced here.

### Phase 4 — Assemble, review, publish
- Render the 90s video (WebCodecs + ElevenLabs + b-roll/stills/cards/map).
- Lands in a **review queue** (not auto-post). You watch + confirm against the brief → approve →
  schedule to Facebook (YouTube/site later).

### Phase 5 — Follow-ups / series  *(later)*
- Track topics over time; generate update episodes as a story develops; link them as a series.

## Suggested MVP (prove it end-to-end on ONE story, e.g. Hormuz)
Phase 1 (brief) + Phase 2 (script) + minimal Phase 3 (**stills + stat cards + one b-roll type**) +
Phase 4 (review → publish). Then enrich visuals (more b-roll, maps), then add follow-ups.
Everything reuses the existing engine (image search + sensitive steering, card/scene renderer,
WebCodecs, ElevenLabs, FB scheduler); the genuinely new work is research→brief, b-roll compositing,
map graphics, and the review queue.

## Open decisions
- **Pexels API key** (free — grab like Serper) for stock b-roll.
- **Where it's triggered/reviewed**: a separate `deep_dive.py`-style script for research + a Studio
  "Deep Dive" panel to review the brief and hit generate (recommended).
- **Voice/model cost**: deep research + script are Claude-heavy — this is where paying for Claude
  quality is most justified (vs Groq). ElevenLabs for voice.
- **Publish targets**: Facebook first; landscape YouTube/website later.

## Risks & mitigations
- Wrong live facts → verify + human review of the brief (Phase 1 gate).
- Visual monotony over 90s → b-roll + stat cards + maps + motion.
- Effort per video → low cadence (2–3×/week) + heavy reuse of the existing engine.
- Hardest technical piece → compositing Pexels video into the WebCodecs render.
