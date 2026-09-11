#!/usr/bin/env python3
"""
Money Odds — resolves past predictions against real results.

Reads predictions.json snapshots that were archived by date (see
generate_predictions.py's companion archive step), checks final
scores via the same free APIs, marks each pick won/lost, and
appends the results into history.json which the site's Track
Record page reads.

This script only grades picks it can actually verify against a
real final score — nothing is marked won/lost on a guess.

DEDUPE NOTE
-----------
A fixture can legitimately appear in MULTIPLE daily archive files while
it's still upcoming (generate_predictions.py re-archives the current
cycle's fixtures every day so kickoff times/data stay fresh). That
means the same real-world match can show up under several different
archive filenames before it's finally played. Grading must therefore
dedupe by the fixture's stable `id`, not by (archive date, match name) —
using the archive date as part of the key was the root cause of the
same match appearing multiple times in history.json with different
dates.
"""

import os
import sys
import json
import time
import datetime
import urllib.request
import urllib.error

FOOTBALL_API_KEY = os.environ.get("FOOTBALL_DATA_API_KEY", "")
BALLDONTLIE_API_KEY = os.environ.get("BALLDONTLIE_API_KEY", "")

FOOTBALL_BASE = "https://api.football-data.org/v4"
BALLDONTLIE_BASE = "https://api.balldontlie.io/nba/v1"

ARCHIVE_DIR = "archive"
OUT_HISTORY = "history.json"
MAX_HISTORY_ITEMS = 500  # every analyzed fixture gets graded now, not just the daily top 8


def http_get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Error fetching {url}: {e}", file=sys.stderr)
        return None


def grade_pick(pick, final_score_text, home_goals, away_goals):
    """Very literal grading: only handles the market types we generate."""
    p = pick.lower()
    total = home_goals + away_goals
    if "over 2.5" in p:
        return total > 2.5
    if "under 2.5" in p:
        return total < 2.5
    if "btts - yes" in p:
        return home_goals > 0 and away_goals > 0
    if "btts - no" in p:
        return not (home_goals > 0 and away_goals > 0)
    if p.endswith("win"):
        return None  # handled by caller with team position context
    if p == "draw":
        return home_goals == away_goals
    return None


def resolve_football(entry):
    """entry is a saved prediction dict with match/league/pick/kickoff."""
    code = entry.get("comp_code")
    if not code:
        return None

    url = f"{FOOTBALL_BASE}/competitions/{code}/matches"
    data = http_get_json(url, headers={"X-Auth-Token": FOOTBALL_API_KEY})
    time.sleep(6.5)
    if not data:
        return None

    for m in data.get("matches", []):
        if m.get("status") != "FINISHED":
            continue
        home_name = m["homeTeam"]["name"]
        away_name = m["awayTeam"]["name"]
        if f"{home_name} vs {away_name}" != entry["match"]:
            continue

        score = m.get("score", {}).get("fullTime", {})
        hg, ag = score.get("home"), score.get("away")
        if hg is None or ag is None:
            continue

        pick = entry["pick"]
        if pick.endswith("Win"):
            team = pick.rsplit(" Win", 1)[0]
            if team == home_name:
                result = hg > ag
            elif team == away_name:
                result = ag > hg
            else:
                result = None
        else:
            result = grade_pick(pick, None, hg, ag)

        if result is None:
            continue
        return {"result": "win" if result else "loss", "final_score": f"{hg}-{ag}"}
    return None


def resolve_basketball(entry):
    game_date = entry.get("kickoff", "")[:10]
    if not game_date:
        return None

    data = http_get_json(
        f"{BALLDONTLIE_BASE}/games?dates[]={game_date}",
        headers={"Authorization": BALLDONTLIE_API_KEY},
    )
    time.sleep(12.5)
    if not data:
        return None

    for g in data.get("data", []):
        if g.get("status") != "Final":
            continue
        home_name = g["home_team"]["full_name"]
        away_name = g["visitor_team"]["full_name"]
        if f"{home_name} vs {away_name}" != entry["match"]:
            continue

        hs, as_ = g.get("home_team_score"), g.get("visitor_team_score")
        if hs is None or as_ is None:
            continue

        pick = entry["pick"]
        if pick.endswith("Win"):
            team = pick.rsplit(" Win", 1)[0]
            result = (hs > as_) if team == home_name else (as_ > hs)
        elif "over" in pick.lower():
            try:
                line = float(pick.lower().replace("over", "").replace("points", "").strip())
                result = (hs + as_) > line
            except ValueError:
                result = None
        else:
            result = None

        if result is None:
            continue
        return {"result": "win" if result else "loss", "final_score": f"{hs}-{as_}"}
    return None


def dedup_key(item):
    """Stable identity for a graded fixture. Real fixtures always carry an
    `id` (football's numeric id or basketball's 'bb-<id>' string) — dedupe
    on that. Only pre-fix legacy entries that were saved without an id fall
    back to (date, match)."""
    fid = item.get("id")
    if fid is not None:
        return ("id", fid)
    return ("legacy", item.get("date"), item.get("match"))


def load_history():
    if not os.path.exists(OUT_HISTORY):
        return []
    with open(OUT_HISTORY) as f:
        try:
            return json.load(f).get("history", [])
        except json.JSONDecodeError:
            return []


def dedup_history(history):
    """One-time cleanup pass: collapses any duplicate entries already sitting
    in history.json (e.g. from the old date-based dedupe bug), keeping the
    first-seen entry for each fixture."""
    seen = set()
    cleaned = []
    for h in history:
        key = dedup_key(h)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(h)
    return cleaned, seen


def main():
    if not os.path.isdir(ARCHIVE_DIR):
        print("No archive directory yet — nothing to resolve.")
        return

    history = load_history()
    history, already_graded = dedup_history(history)
    removed = len(load_history()) - len(history)
    if removed:
        print(f"Deduped {removed} pre-existing duplicate history entr{'y' if removed == 1 else 'ies'}.")

    for fname in sorted(os.listdir(ARCHIVE_DIR)):
        if not fname.endswith(".json"):
            continue
        date_str = fname.replace(".json", "")

        # Only resolve archives from yesterday or earlier
        if date_str >= datetime.date.today().isoformat():
            continue

        with open(os.path.join(ARCHIVE_DIR, fname)) as f:
            day_data = json.load(f)

        for entry in day_data.get("predictions", []):
            key = dedup_key({"id": entry.get("id"), "date": date_str, "match": entry["match"]})
            if key in already_graded:
                continue

            if entry["sport"] == "Football":
                outcome = resolve_football(entry)
            elif entry["sport"] == "Basketball":
                outcome = resolve_basketball(entry)
            else:
                outcome = None

            if outcome is None:
                continue

            history.append({
                "date": date_str,
                "id": entry.get("id"),
                "sport": entry["sport"],
                "match": entry["match"],
                "league": entry["league"],
                "pick": entry["pick"],
                "result": outcome["result"],
                "final_score": outcome["final_score"],
            })
            # Mark graded immediately so a later archive file that still
            # contains this same still-cached fixture doesn't add it again
            # within this same run — this was the second half of the bug.
            already_graded.add(key)

    history.sort(key=lambda h: h["date"], reverse=True)
    history = history[:MAX_HISTORY_ITEMS]

    with open(OUT_HISTORY, "w") as f:
        json.dump({"history": history}, f, indent=2)

    print(f"history.json now has {len(history)} graded predictions (deduped by fixture id)")


if __name__ == "__main__":
    main()
