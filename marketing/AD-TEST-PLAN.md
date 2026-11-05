# Gem Jam: ad concept test

Same method as Flock Rescue's test, applied to Gem Jam: a few short video ads,
each pitching a different hook, all pointing at one landing page, compared on
how cheaply each gets people to click and play. Budget realism from the
research: $100–300 per concept measures hook rate, CTR and the landing-page
click, not CPI; real CPI and retention come from a publisher-funded Android
prototype afterwards.

## Concepts

| File | Hook | What it tests |
|---|---|---|
| `ad-gem-avalanche.mp4` | Calm matching, the board lines up, carts fill themselves in a run, Fever to finish | Does the spectacle sell? |
| `ad-gem-so-close.mp4` | Clean play, the tray fills with two carts to go, "Only 3% fill every cart. Can you?" | Does the challenge ("I could do better") sell? |
| `ad-critter-*.mp4` (same cuts, `?skin=critters`) | Animals boarding buses instead of gems and carts | Do faces beat gems? |

The fail ad shows the real core loop failing, which is the compliant form of
the genre's "wrong choice" ads (ASA: the ad must reflect the core playing
experience; Royal Match shipped its ad puzzles as real levels).

All clips are 1080×1920, silent (add music from Meta's library), 17–25 s.

## Landing page

`https://ngb0004.github.io/critter-jam/` (the game itself for now; a
"coming soon + play free" landing page with the trailer goes at the root and
the game moves to `/play/` before the ads run, as with Flock Rescue).

## Setup (Meta Ads Manager)

1. Campaign objective **Traffic**, destination the landing page, Advantage
   campaign budget **off**.
2. One ad set per concept, identical except the video: **$25–40/day for 3–5
   days**, United States, age 18–65+, all genders, Advantage+ placements,
   broad targeting. Let Meta show who responds.
3. CTA **Play Game**. Append `?utm_source=meta&utm_campaign=gem1&utm_content=<concept>`
   to each ad's URL.

### Copy

- Avalanche: "Line them up… then watch the AVALANCHE 💎🚂 Play free in your browser."
- So close: "Two carts to go and the tray fills up 😱 Only 3% finish this one. Can you?"
- Critters: "Everybody on the bus! 🐾🚌 The cutest sorting puzzle you'll play this week."

## Reading it (after 3–5 days)

| Metric | Meaning | Good |
|---|---|---|
| Hook rate (3-s plays ÷ impressions) | Does the first second stop the scroll? | 25–30%+ |
| CTR (link clicks ÷ impressions) | Does the ad make people want it? | 1%+ decent, 2%+ strong |
| Cost per landing-page view | What a visitor costs | compare concepts |
| Landing-page "Play" click rate | Did they try it? | the real signal |
| Age × gender breakdown | Who responds to which hook | answers the audience question |

Decision rule: the concept with the lowest cost per play click wins the next
round of investment; if all CTRs sit under 0.7%, the hook needs work before
the game does. Convert the winner's CPC to an implied CPI at about 8%
click-to-install; anything above about $3 is dead regardless of retention.

## After the test

Winner → Google Play prototype (Capacitor wrap of this build) submitted to a
publisher's free testing programme (Homa, Voodoo, Supersonic) for real CPI,
D1/D3/D7 and playtime at their cost. Greenlight in 2026 terms: CPI ≤ $1 on US
Android, D1 ≥ 40%, D7 ≥ 12%, 15–30 minutes of cumulative playtime, CPI stable
across several videos.
