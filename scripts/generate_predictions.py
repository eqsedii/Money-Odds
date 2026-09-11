#!/usr/bin/env python3
"""
Money Odds — automated prediction generator.

Pulls real fixtures/results from free APIs and computes statistical
predictions (no bookmaker odds are used or faked — everything shown
is derived from the model itself).

SUBSCRIPTION CYCLE WINDOW
--------------------------
Access renews on a 7-day cycle that runs Saturday -> Saturday. We never
want to generate (or sell) predictions for fixtures that fall after the
current cycle's boundary, since a subscriber who pays today shouldn't
be shown picks for a match that belongs to next cycle's payment period.

Concretely: every day this script runs, it recomputes the *current*
cycle (the most recent Saturday through the following Friday) and only
considers fixtures up to and including that Friday. As the week
progresses the window naturally shrinks (Wednesday's run only looks
out to Friday, not a fresh 7 days from Wednesday) and kickoff
times/lineups/etc. for those same fixtures get refreshed daily. Once
Saturday arrives, a new 7-day cycle begins automatically.

Writes PUBLIC files (committed to the public repo — no pick/confidence/
odds/markets ever appear here, so a paying subscription is meaningful):
  - predictions.json     Today's/soonest featured fixtures + multi-bet
                          slates, redacted — id/teams/league only
  - fixtures.json        EVERY fixture in the current cycle, redacted the
                          same way — this is what powers site-wide search
  - match_details.json   Head-to-head + recent form — NOT proprietary,
                          stays public, keeps the free tier valuable

Writes PRIVATE files (never committed to the public repo — the CI
workflow pushes these to a separate private repo instead):
  - private_picks.json   The actual proprietary picks/confidence/odds/
                          markets, keyed by fixture id, plus full
                          multi-bet legs. The Cloudflare Worker fetches
                          this server-side after verifying a real payment.
  - archive/<date>.json  Full pick data for grading later — private for
                          the same reason (would leak upcoming picks
                          otherwise).

Data sources (both free):
  - Football: football-data.org (12 major competitions)
  - Basketball: balldontlie.io (NBA)

Run with:
  FOOTBALL_DATA_API_KEY=... BALLDONTLIE_API_KEY=... python3 generate_predictions.py
"""

import os
import sys
import json
import time
import math
import datetime
import urllib.request
import urllib.error

FOOTBALL_API_KEY = os.environ.get("FOOTBALL_DATA_API_KEY", "")
BALLDONTLIE_API_KEY = os.environ.get("BALLDONTLIE_API_KEY", "")

FOOTBALL_BASE = "https://api.football-data.org/v4"
BALLDONTLIE_BASE = "https://api.balldontlie.io/nba/v1"

# The 12 competitions available on football-data.org's free tier
COMPETITIONS = ["PL", "PD", "BL1", "SA", "FL1", "DED", "PPL", "ELC", "BSA", "CL", "WC", "EC"]

MIN_SAMPLE = 2       # minimum home/away matches before we trust a team's numbers
TOP_N_SINGLES = 8    # how many single picks to feature on predictions.json
MULTI_LEG_COUNTS = [2, 3]  # accumulator sizes to build from the top picks

# --- subscription cycle window -------------------------------------------
CYCLE_LENGTH_DAYS = 7
CYCLE_ANCHOR_WEEKDAY = 5  # Python's date.weekday(): Monday=0 ... Saturday=5, Sunday=6

MAX_H2H_CALLS = 40  # cap on head-to-head API calls per run (rate-limit / politeness budget)
RECENT_FORM_N = 5

OUT_PREDICTIONS = "predictions.json"
OUT_FIXTURES = "fixtures.json"
OUT_MATCH_DETAILS = "match_details.json"
OUT_PRIVATE_PICKS = "private_picks.json"
OUT_HISTORY = "history.json"

# ---------------------------------------------------------------- utilities

def compute_cycle_window(today=None):
    """Returns (cycle_start, cycle_end_exclusive) for the CURRENT subscription
    cycle. Cycles run Saturday -> Saturday. cycle_end_exclusive is the next
    Saturday (i.e. the first day that belongs to the *following* cycle) —
    callers should treat cycle_end_exclusive - 1 day as the last valid day
    to pull fixtures for."""
    today = today or datetime.date.today()
    days_since_anchor = (today.weekday() - CYCLE_ANCHOR_WEEKDAY) % CYCLE_LENGTH_DAYS
    cycle_start = today - datetime.timedelta(days=days_since_anchor)
    cycle_end_exclusive = cycle_start + datetime.timedelta(days=CYCLE_LENGTH_DAYS)
    return cycle_start, cycle_end_exclusive


def http_get_json(url, headers=None, retries=3):
    headers = headers or {}
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8")
            except Exception:
                pass
            if e.code == 429:
                time.sleep(8)
                continue
            print(f"HTTP error {e.code} for {url} — response body: {body}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"Error fetching {url}: {e}", file=sys.stderr)
            time.sleep(2)
    return None


def poisson_pmf(k, lam):
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def poisson_cdf(k, lam):
    return sum(poisson_pmf(i, lam) for i in range(0, k + 1))


def avg(lst):
    return sum(lst) / len(lst) if lst else None

# ---------------------------------------------------------------- football

def fetch_competition_matches(code):
    url = f"{FOOTBALL_BASE}/competitions/{code}/matches"
    data = http_get_json(url, headers={"X-Auth-Token": FOOTBALL_API_KEY})
    time.sleep(6.5)  # stay under 10 req/min
    if not data or "matches" not in data:
        return []
    return data["matches"]


def fetch_head2head(match_id, limit=5):
    url = f"{FOOTBALL_BASE}/matches/{match_id}/head2head?limit={limit}"
    data = http_get_json(url, headers={"X-Auth-Token": FOOTBALL_API_KEY})
    time.sleep(6.5)
    if not data:
        return None
    agg = data.get("aggregates", {})
    matches_out = []
    for m in data.get("matches", [])[:limit]:
        score = m.get("score", {}).get("fullTime", {})
        matches_out.append({
            "date": m.get("utcDate", "")[:10],
            "home": m.get("homeTeam", {}).get("name"),
            "away": m.get("awayTeam", {}).get("name"),
            "score": f"{score.get('home', '?')}-{score.get('away', '?')}",
            "competition": m.get("competition", {}).get("name"),
        })
    return {
        "number_of_matches": agg.get("numberOfMatches"),
        "home_wins": agg.get("homeTeam", {}).get("wins"),
        "draws": agg.get("homeTeam", {}).get("draws"),
        "away_wins": agg.get("awayTeam", {}).get("wins"),
        "matches": matches_out,
    }


def compute_team_football_stats(matches):
    """Returns per-team home/away scoring & conceding averages, plus league averages."""
    teams = {}

    def ensure(team_id, name):
        if team_id not in teams:
            teams[team_id] = {
                "name": name,
                "home_for": [], "home_against": [],
                "away_for": [], "away_against": [],
            }

    home_goals_all, away_goals_all = [], []
    for m in matches:
        if m.get("status") != "FINISHED":
            continue
        score = m.get("score", {}).get("fullTime", {})
        hg, ag = score.get("home"), score.get("away")
        if hg is None or ag is None:
            continue
        home = m["homeTeam"]
        away = m["awayTeam"]
        ensure(home["id"], home["name"])
        ensure(away["id"], away["name"])
        teams[home["id"]]["home_for"].append(hg)
        teams[home["id"]]["home_against"].append(ag)
        teams[away["id"]]["away_for"].append(ag)
        teams[away["id"]]["away_against"].append(hg)
        home_goals_all.append(hg)
        away_goals_all.append(ag)

    league_avg_home = sum(home_goals_all) / len(home_goals_all) if home_goals_all else 1.4
    league_avg_away = sum(away_goals_all) / len(away_goals_all) if away_goals_all else 1.1
    return teams, league_avg_home, league_avg_away


def recent_form_football(team_id, matches, n=RECENT_FORM_N):
    """Last n finished matches (any venue) for a team, most recent first."""
    played = []
    for m in matches:
        if m.get("status") != "FINISHED":
            continue
        home, away = m["homeTeam"], m["awayTeam"]
        if home["id"] != team_id and away["id"] != team_id:
            continue
        score = m.get("score", {}).get("fullTime", {})
        hg, ag = score.get("home"), score.get("away")
        if hg is None or ag is None:
            continue
        is_home = home["id"] == team_id
        for_score, against_score = (hg, ag) if is_home else (ag, hg)
        if for_score > against_score:
            result = "W"
        elif for_score < against_score:
            result = "L"
        else:
            result = "D"
        played.append({
            "date": m.get("utcDate", "")[:10],
            "opponent": away["name"] if is_home else home["name"],
            "venue": "H" if is_home else "A",
            "score": f"{for_score}-{against_score}",
            "result": result,
        })
    played.sort(key=lambda x: x["date"], reverse=True)
    return played[:n]


def compute_football_pick(home, away, ht, at, lg_home, lg_away):
    attack_home = avg(ht["home_for"]) / lg_home
    defence_home = avg(ht["home_against"]) / lg_away
    attack_away = avg(at["away_for"]) / lg_away
    defence_away = avg(at["away_against"]) / lg_home

    lam_home = attack_home * defence_away * lg_home
    lam_away = attack_away * defence_home * lg_away
    lam_total = lam_home + lam_away

    p_over25 = 1 - poisson_cdf(2, lam_total)
    p_under25 = 1 - p_over25
    p_btts_yes = (1 - math.exp(-lam_home)) * (1 - math.exp(-lam_away))
    p_btts_no = 1 - p_btts_yes

    p_home_win = p_draw = p_away_win = 0.0
    for i in range(0, 8):
        for j in range(0, 8):
            p = poisson_pmf(i, lam_home) * poisson_pmf(j, lam_away)
            if i > j:
                p_home_win += p
            elif i == j:
                p_draw += p
            else:
                p_away_win += p

    candidates = [
        ("Over 2.5 Goals", p_over25),
        ("Under 2.5 Goals", p_under25),
        ("BTTS - Yes", p_btts_yes),
        ("BTTS - No", p_btts_no),
        (f"{home['name']} Win", p_home_win),
        ("Draw", p_draw),
        (f"{away['name']} Win", p_away_win),
    ]
    best_pick, best_prob = max(candidates, key=lambda c: c[1])
    markets = sorted(
        [{"label": label, "probability": round(prob * 100)} for label, prob in candidates],
        key=lambda m: m["probability"],
        reverse=True,
    )
    return best_pick, best_prob, markets, {
        "home_expected_goals": round(lam_home, 2),
        "away_expected_goals": round(lam_away, 2),
    }


def build_football_fixtures(competitions=COMPETITIONS):
    """Returns ALL fixtures within the CURRENT subscription cycle (Saturday ->
    the following Friday, whatever's left of it from today), across all
    competitions, each with a computed pick — this is the full searchable set."""
    fixtures = []
    today = datetime.date.today()
    _, cycle_end_exclusive = compute_cycle_window(today)
    window_end = cycle_end_exclusive - datetime.timedelta(days=1)

    for code in competitions:
        matches = fetch_competition_matches(code)
        if not matches:
            print(f"[{code}] No matches returned at all (API error, wrong code, or empty response)")
            continue

        statuses = {}
        for m in matches:
            s = m.get("status", "UNKNOWN")
            statuses[s] = statuses.get(s, 0) + 1
        print(f"[{code}] {len(matches)} total matches | status counts: {statuses}")

        teams, lg_home, lg_away = compute_team_football_stats(matches)

        upcoming = [
            m for m in matches
            if m.get("status") in ("SCHEDULED", "TIMED")
            and m.get("utcDate", "")[:10] >= str(today)
            and m.get("utcDate", "")[:10] <= str(window_end)
        ]

        for m in upcoming:
            home, away = m["homeTeam"], m["awayTeam"]
            ht, at = teams.get(home["id"]), teams.get(away["id"])
            if not ht or not at:
                continue
            if len(ht["home_for"]) < MIN_SAMPLE or len(at["away_for"]) < MIN_SAMPLE:
                continue

            best_pick, best_prob, markets, xg = compute_football_pick(home, away, ht, at, lg_home, lg_away)
            fixtures.append({
                "id": m["id"],
                "sport": "Football",
                "icon": "⚽",
                "match": f"{home['name']} vs {away['name']}",
                "home_team": home["name"],
                "away_team": away["name"],
                "home_team_id": home["id"],
                "away_team_id": away["id"],
                "league": m.get("competition", {}).get("name", code),
                "comp_code": code,
                "kickoff": m.get("utcDate"),
                "pick": best_pick,
                "confidence": round(best_prob * 100),
                "fair_odds": round(1 / best_prob, 2) if best_prob > 0 else None,
                "markets": markets,
                "expected_goals": xg,
                "_all_matches_ref": matches,  # kept only for building match_details below; stripped before writing
            })
    return fixtures

# ---------------------------------------------------------------- basketball

def bl_get(path):
    url = f"{BALLDONTLIE_BASE}{path}"
    data = http_get_json(url, headers={"Authorization": BALLDONTLIE_API_KEY})
    time.sleep(12.5)  # free tier: 5 req/min
    return data


def build_basketball_fixtures():
    """Returns fixtures for EVERY day left in the current subscription cycle
    (today through the cycle's closing Friday), not just today — mirrors the
    football window so the site always has a full cycle's worth of picks."""
    if not BALLDONTLIE_API_KEY:
        return []

    today = datetime.date.today()
    _, cycle_end_exclusive = compute_cycle_window(today)
    window_end = cycle_end_exclusive - datetime.timedelta(days=1)

    fixtures = []
    season = today.year if today.month >= 10 else today.year - 1
    team_games_cache = {}

    def team_games(team_id):
        if team_id in team_games_cache:
            return team_games_cache[team_id]
        resp = bl_get(f"/games?team_ids[]={team_id}&seasons[]={season}&per_page=25")
        games = resp["data"] if resp and resp.get("data") else []
        team_games_cache[team_id] = games
        return games

    def scoring_avg(team_id):
        games = team_games(team_id)
        scored, allowed = [], []
        for g in games:
            if g.get("status") != "Final":
                continue
            is_home = g["home_team"]["id"] == team_id
            f = g["home_team_score"] if is_home else g["visitor_team_score"]
            a = g["visitor_team_score"] if is_home else g["home_team_score"]
            if f is not None and a is not None:
                scored.append(f)
                allowed.append(a)
        return {"scored": avg(scored), "allowed": avg(allowed), "n": len(scored)}

    def recent_form_bball(team_id, n=RECENT_FORM_N):
        games = team_games(team_id)
        played = []
        for g in games:
            if g.get("status") != "Final":
                continue
            is_home = g["home_team"]["id"] == team_id
            f = g["home_team_score"] if is_home else g["visitor_team_score"]
            a = g["visitor_team_score"] if is_home else g["home_team_score"]
            opp = g["visitor_team"]["full_name"] if is_home else g["home_team"]["full_name"]
            played.append({
                "date": g.get("date", "")[:10],
                "opponent": opp,
                "venue": "H" if is_home else "A",
                "score": f"{f}-{a}",
                "result": "W" if f > a else ("L" if f < a else "D"),
            })
        played.sort(key=lambda x: x["date"], reverse=True)
        return played[:n]

    seen_game_ids = set()
    day = today
    while day <= window_end:
        games_resp = bl_get(f"/games?dates[]={day.isoformat()}")
        day += datetime.timedelta(days=1)
        if not games_resp or not games_resp.get("data"):
            continue

        for g in games_resp["data"]:
            if g.get("id") in seen_game_ids:
                continue  # guards against the same game appearing twice if a date query is ever re-run
            if g.get("status") == "Final":
                continue
            seen_game_ids.add(g.get("id"))

            home, away = g["home_team"], g["visitor_team"]
            hs, as_ = scoring_avg(home["id"]), scoring_avg(away["id"])
            if hs["n"] < MIN_SAMPLE or as_["n"] < MIN_SAMPLE:
                continue

            pred_home = (hs["scored"] + as_["allowed"]) / 2 * 1.02
            pred_away = (as_["scored"] + hs["allowed"]) / 2
            diff = pred_home - pred_away
            total = pred_home + pred_away
            win_prob_home = 1 / (1 + math.exp(-diff / 6))

            if abs(diff) >= 2:
                pick = f"{home['full_name']} Win" if diff > 0 else f"{away['full_name']} Win"
                confidence = max(win_prob_home, 1 - win_prob_home)
            else:
                pick = f"Over {round(total - 1, 1)} Points"
                confidence = 0.58

            bball_markets = sorted([
                {"label": f"{home['full_name']} Win", "probability": round(win_prob_home * 100)},
                {"label": f"{away['full_name']} Win", "probability": round((1 - win_prob_home) * 100)},
                {"label": f"Over {round(total - 1, 1)} Points", "probability": round(confidence * 100) if "Over" in pick else 58},
                {"label": f"Under {round(total - 1, 1)} Points", "probability": 100 - (round(confidence * 100) if "Over" in pick else 58)},
            ], key=lambda m: m["probability"], reverse=True)

            # Simple season-only head-to-head derived from data we already fetched (no extra calls)
            h2h_games = [
                gm for gm in team_games(home["id"])
                if gm.get("status") == "Final"
                and away["id"] in (gm["home_team"]["id"], gm["visitor_team"]["id"])
            ]
            h2h_matches = []
            for gm in h2h_games[:5]:
                h2h_matches.append({
                    "date": gm.get("date", "")[:10],
                    "home": gm["home_team"]["full_name"],
                    "away": gm["visitor_team"]["full_name"],
                    "score": f"{gm['home_team_score']}-{gm['visitor_team_score']}",
                    "competition": "NBA",
                })

            fixtures.append({
                "id": f"bb-{g['id']}",
                "sport": "Basketball",
                "icon": "🏀",
                "match": f"{home['full_name']} vs {away['full_name']}",
                "home_team": home["full_name"],
                "away_team": away["full_name"],
                "home_team_id": home["id"],
                "away_team_id": away["id"],
                "league": "NBA",
                "kickoff": g.get("date"),
                "pick": pick,
                "confidence": round(confidence * 100),
                "fair_odds": round(1 / confidence, 2),
                "markets": bball_markets,
                "predicted_score": {"home": round(pred_home, 1), "away": round(pred_away, 1)},
                "_home_recent": recent_form_bball(home["id"]),
                "_away_recent": recent_form_bball(away["id"]),
                "_h2h": {
                    "number_of_matches": len(h2h_matches),
                    "matches": h2h_matches,
                } if h2h_matches else None,
            })
    return fixtures

# ---------------------------------------------------------------- assembly

def build_multi_bets(all_picks):
    ranked = sorted(all_picks, key=lambda p: p["confidence"], reverse=True)
    multis = []
    used = set()
    for size in MULTI_LEG_COUNTS:
        legs = [p for p in ranked if p["match"] not in used][:size]
        if len(legs) < size:
            continue
        combined_prob = 1.0
        for l in legs:
            combined_prob *= l["confidence"] / 100
        multis.append({
            "title": f"{size}-Leg Accumulator",
            "combined_fair_odds": round(1 / combined_prob, 2) if combined_prob > 0 else None,
            "legs": [
                {"id": l["id"], "icon": l["icon"], "match": l["match"], "meta": l["league"], "pick": l["pick"]}
                for l in legs
            ],
        })
        for l in legs:
            used.add(l["match"])
    return multis


SENSITIVE_FIELDS = {"pick", "confidence", "fair_odds", "markets", "expected_goals", "predicted_score"}


def strip_internal_fields(fixture):
    return {k: v for k, v in fixture.items() if not k.startswith("_")}


def redact_for_public(fixture):
    """Public version: strips proprietary pick/confidence/odds/markets entirely.
    This is what fixtures.json (and everyone browsing the site) actually sees."""
    return {k: v for k, v in fixture.items() if k not in SENSITIVE_FIELDS} | {"locked": True}


def extract_private_fields(fixture):
    """The proprietary half — only ever written to the private repo."""
    return {k: fixture[k] for k in SENSITIVE_FIELDS if k in fixture}


def main():
    print(f"FOOTBALL_DATA_API_KEY length: {len(FOOTBALL_API_KEY)} (should be 32 for a normal token)")
    print(f"BALLDONTLIE_API_KEY length: {len(BALLDONTLIE_API_KEY)}")

    cycle_start, cycle_end_exclusive = compute_cycle_window()
    print(f"Subscription cycle window: {cycle_start} -> {cycle_end_exclusive - datetime.timedelta(days=1)} "
          f"(inclusive), next cycle starts {cycle_end_exclusive}")

    football_fixtures = build_football_fixtures() if FOOTBALL_API_KEY else []
    basketball_fixtures = build_basketball_fixtures()
    all_fixtures = football_fixtures + basketball_fixtures
    all_fixtures.sort(key=lambda f: f.get("kickoff") or "")

    # --- match_details.json: head-to-head + recent form, keyed by match id ---
    match_details = {}

    # Football: fetch real head-to-head via API, capped and soonest-first
    football_by_kickoff = sorted(football_fixtures, key=lambda f: f.get("kickoff") or "")
    h2h_budget = MAX_H2H_CALLS
    for fx in football_by_kickoff:
        matches_ref = fx["_all_matches_ref"]
        home_recent = recent_form_football(fx["home_team_id"], matches_ref)
        away_recent = recent_form_football(fx["away_team_id"], matches_ref)
        h2h = None
        if h2h_budget > 0:
            h2h = fetch_head2head(fx["id"])
            h2h_budget -= 1
        match_details[str(fx["id"])] = {
            "home_recent": home_recent,
            "away_recent": away_recent,
            "h2h": h2h,
        }
    if h2h_budget <= 0:
        print(f"Reached MAX_H2H_CALLS budget ({MAX_H2H_CALLS}) — remaining fixtures have recent form but no head-to-head this run.")

    # Basketball: recent form + season-only h2h already computed inline
    for fx in basketball_fixtures:
        match_details[str(fx["id"])] = {
            "home_recent": fx.get("_home_recent", []),
            "away_recent": fx.get("_away_recent", []),
            "h2h": fx.get("_h2h"),
        }

    # --- clean fixture objects (full data — this is the PRIVATE version) ---
    clean_fixtures = [strip_internal_fields(fx) for fx in all_fixtures]

    # --- PUBLIC fixtures.json: everyone sees this, no pick/confidence/odds ---
    public_fixtures = [redact_for_public(fx) for fx in clean_fixtures]
    with open(OUT_FIXTURES, "w") as f:
        json.dump({
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "cycle_start": cycle_start.isoformat(),
            "cycle_end": (cycle_end_exclusive - datetime.timedelta(days=1)).isoformat(),
            "fixtures": public_fixtures,
        }, f, indent=2)

    # match_details.json (H2H + recent form) is NOT proprietary — real stats,
    # not our pick — so it stays public and helps the free tier feel valuable.
    with open(OUT_MATCH_DETAILS, "w") as f:
        json.dump(match_details, f, indent=2)

    # --- ranking + multi-bets use the FULL (private) data ---
    ranked = sorted(clean_fixtures, key=lambda p: p["confidence"], reverse=True)
    top_singles = ranked[:TOP_N_SINGLES]
    multis = build_multi_bets(ranked)

    # --- PUBLIC predictions.json: which matches are featured, no picks ---
    public_top_singles = [redact_for_public(fx) for fx in top_singles]
    public_multis = [
        {
            "title": m["title"],
            "locked": True,
            "legs": [{"id": l["id"], "icon": l["icon"], "match": l["match"], "meta": l["meta"]} for l in m["legs"]],
        }
        for m in multis
    ]
    with open(OUT_PREDICTIONS, "w") as f:
        json.dump({
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "cycle_start": cycle_start.isoformat(),
            "cycle_end": (cycle_end_exclusive - datetime.timedelta(days=1)).isoformat(),
            "predictions": public_top_singles,
            "multi_bets": public_multis,
        }, f, indent=2)

    # --- PRIVATE data: the actual proprietary picks — pushed to the private
    # repo only, never committed here. The Worker fetches this server-side
    # after verifying a real payment. ---
    picks_map = {str(fx["id"]): extract_private_fields(fx) for fx in clean_fixtures}
    with open(OUT_PRIVATE_PICKS, "w") as f:
        json.dump({
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "cycle_start": cycle_start.isoformat(),
            "cycle_end": (cycle_end_exclusive - datetime.timedelta(days=1)).isoformat(),
            "picks": picks_map,
            "multi_bets": multis,  # full version, with real picks + combined odds
        }, f, indent=2)

    # Archive EVERY analyzed fixture (not just the featured top picks) so the
    # Track Record page reflects everything we actually predicted, not just
    # the headline slate. This file goes to the private repo, never the
    # public one, since it holds real pick data for still-upcoming games.
    os.makedirs("archive", exist_ok=True)
    today_str = datetime.date.today().isoformat()
    with open(os.path.join("archive", f"{today_str}.json"), "w") as f:
        json.dump({"predictions": clean_fixtures}, f, indent=2)

    print(f"Wrote {len(clean_fixtures)} total fixtures ({len(public_fixtures)} public/redacted), "
          f"{len(top_singles)} featured picks, {len(multis)} multi-bets, "
          f"{len(match_details)} match-detail entries, and {len(picks_map)} private picks.")


if __name__ == "__main__":
    main()
