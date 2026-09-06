#!/usr/bin/env python3
"""
Money Odds — automated prediction generator.

Pulls real fixtures/results from free APIs and computes statistical
predictions (no bookmaker odds are used or faked — everything shown
is derived from the model itself). Writes predictions.json (today's
picks) which the site fetches at runtime.

Data sources (both free):
  - Football: football-data.org  (12 major competitions)
  - Basketball: balldontlie.io    (NBA)

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

MIN_SAMPLE = 2          # minimum home/away matches before we trust a team's numbers (low early in a season)
TOP_N_SINGLES = 8       # how many single picks to publish
MULTI_LEG_COUNTS = [2, 3]  # accumulator sizes to build from the top picks

OUT_PREDICTIONS = "predictions.json"
OUT_HISTORY = "history.json"


# ---------------------------------------------------------------- utilities

def http_get_json(url, headers=None, retries=3):
    headers = headers or {}
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(8)
                continue
            print(f"HTTP error {e.code} for {url}", file=sys.stderr)
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


# ---------------------------------------------------------------- football

def fetch_competition_matches(code):
    url = f"{FOOTBALL_BASE}/competitions/{code}/matches"
    data = http_get_json(url, headers={"X-Auth-Token": FOOTBALL_API_KEY})
    time.sleep(6.5)  # stay under 10 req/min
    if not data or "matches" not in data:
        return []
    return data["matches"]


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


def avg(lst):
    return sum(lst) / len(lst) if lst else None


def build_football_predictions(competitions=COMPETITIONS):
    picks = []
    today = datetime.date.today()

    for code in competitions:
        matches = fetch_competition_matches(code)
        if not matches:
            print(f"[{code}] No matches returned at all (API error, wrong code, or empty response)")
            continue

        statuses = {}
        for m in matches:
            s = m.get("status", "UNKNOWN")
            statuses[s] = statuses.get(s, 0) + 1
        upcoming_dates = sorted([
            m.get("utcDate", "")[:10] for m in matches
            if m.get("status") in ("SCHEDULED", "TIMED")
        ])
        print(f"[{code}] {len(matches)} total matches | status counts: {statuses} | "
              f"next upcoming dates: {upcoming_dates[:5]}")

        teams, lg_home, lg_away = compute_team_football_stats(matches)

        # Look ahead 5 days instead of just today/tomorrow — domestic
        # leagues often pause for a week during FIFA international
        # breaks, and a 1-2 day window can come up empty even though
        # real upcoming fixtures exist a few days out.
        window_end = today + datetime.timedelta(days=5)
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
                print(f"[{code}] Skipping {home['name']} vs {away['name']}: no historical data for one team")
                continue
            if len(ht["home_for"]) < MIN_SAMPLE or len(at["away_for"]) < MIN_SAMPLE:
                print(f"[{code}] Skipping {home['name']} vs {away['name']}: "
                      f"only {len(ht['home_for'])} home / {len(at['away_for'])} away sample matches")
                continue

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

            # simple 1x2 via independent Poisson grid
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

            picks.append({
                "sport": "Football",
                "icon": "⚽",
                "match": f"{home['name']} vs {away['name']}",
                "league": m.get("competition", {}).get("name", code),
                "comp_code": code,
                "kickoff": m.get("utcDate"),
                "pick": best_pick,
                "confidence": round(best_prob * 100),
                "fair_odds": round(1 / best_prob, 2) if best_prob > 0 else None,
            })

    return picks


# ---------------------------------------------------------------- basketball

def bl_get(path):
    url = f"{BALLDONTLIE_BASE}{path}"
    data = http_get_json(url, headers={"Authorization": BALLDONTLIE_API_KEY})
    time.sleep(12.5)  # free tier: 5 req/min
    return data


def build_basketball_predictions():
    if not BALLDONTLIE_API_KEY:
        return []

    today = datetime.date.today().isoformat()
    games_resp = bl_get(f"/games?dates[]={today}")
    if not games_resp or not games_resp.get("data"):
        return []

    picks = []
    season = datetime.date.today().year if datetime.date.today().month >= 10 else datetime.date.today().year - 1

    team_cache = {}

    def team_scoring_avg(team_id):
        if team_id in team_cache:
            return team_cache[team_id]
        resp = bl_get(f"/games?team_ids[]={team_id}&seasons[]={season}&per_page=25")
        if not resp or not resp.get("data"):
            team_cache[team_id] = None
            return None
        scored, allowed = [], []
        for g in resp["data"]:
            if g.get("status") != "Final":
                continue
            is_home = g["home_team"]["id"] == team_id
            for_score = g["home_team_score"] if is_home else g["visitor_team_score"]
            against_score = g["visitor_team_score"] if is_home else g["home_team_score"]
            if for_score is not None and against_score is not None:
                scored.append(for_score)
                allowed.append(against_score)
        result = {"scored": avg(scored), "allowed": avg(allowed), "n": len(scored)}
        team_cache[team_id] = result
        return result

    for g in games_resp["data"]:
        if g.get("status") == "Final":
            continue
        home, away = g["home_team"], g["visitor_team"]
        hs = team_scoring_avg(home["id"])
        as_ = team_scoring_avg(away["id"])
        if not hs or not as_ or hs["n"] < MIN_SAMPLE or as_["n"] < MIN_SAMPLE:
            continue

        pred_home = (hs["scored"] + as_["allowed"]) / 2 * 1.02  # small home-court bump
        pred_away = (as_["scored"] + hs["allowed"]) / 2
        diff = pred_home - pred_away
        total = pred_home + pred_away

        # crude logistic mapping of point-diff to win probability
        win_prob_home = 1 / (1 + math.exp(-diff / 6))

        if abs(diff) >= 2:
            pick = f"{home['full_name']} Win" if diff > 0 else f"{away['full_name']} Win"
            confidence = max(win_prob_home, 1 - win_prob_home)
        else:
            pick = f"Over {round(total - 1, 1)} Points"
            confidence = 0.58  # weak edge, flat modest confidence

        picks.append({
            "sport": "Basketball",
            "icon": "🏀",
            "match": f"{home['full_name']} vs {away['full_name']}",
            "league": "NBA",
            "kickoff": g.get("date"),
            "pick": pick,
            "confidence": round(confidence * 100),
            "fair_odds": round(1 / confidence, 2),
        })

    return picks


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
                {"icon": l["icon"], "match": l["match"], "meta": l["league"], "pick": l["pick"]}
                for l in legs
            ],
        })
        for l in legs:
            used.add(l["match"])
    return multis


def main():
    football_picks = build_football_predictions() if FOOTBALL_API_KEY else []
    basketball_picks = build_basketball_predictions()

    all_picks = football_picks + basketball_picks
    all_picks.sort(key=lambda p: p["confidence"], reverse=True)
    top_singles = all_picks[:TOP_N_SINGLES]

    multis = build_multi_bets(all_picks)

    output = {
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "predictions": top_singles,
        "multi_bets": multis,
    }

    with open(OUT_PREDICTIONS, "w") as f:
        json.dump(output, f, indent=2)

    # Archive today's published picks (with comp_code intact) so the
    # resolver script can grade them against real results tomorrow.
    os.makedirs("archive", exist_ok=True)
    today_str = datetime.date.today().isoformat()
    with open(os.path.join("archive", f"{today_str}.json"), "w") as f:
        json.dump({"predictions": top_singles}, f, indent=2)

    print(f"Wrote {len(top_singles)} single picks and {len(multis)} multi-bets to {OUT_PREDICTIONS}")


if __name__ == "__main__":
    main()
