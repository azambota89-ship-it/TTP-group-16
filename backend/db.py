"""SQLite storage for flood reports and admin accounts."""
import sqlite3
from datetime import datetime, timedelta, timezone

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    type        TEXT,
    road_name   TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    source      TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    reported_at TEXT    NOT NULL,
    sample      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL
);
"""

# Sample data shown on a fresh database (same points as frontend/mock/floods.json).
SAMPLE_REPORTS = [
    dict(lat=4.3105, lon=101.1490, source="met", status="reported", type=None, road_name="",
         description="Flood warning area (sample)", hours_ago=4),
    dict(lat=4.3040, lon=101.1580, source="user", status="pending", type=None, road_name="",
         description="Water over road (sample)", hours_ago=3),
    dict(lat=4.3160, lon=101.1620, source="user", status="verified", type=None, road_name="",
         description="Road impassable (sample)", hours_ago=2),
]


def now_iso(delta_hours=0):
    """Current UTC time (optionally shifted) as an ISO 8601 string.

    All timestamps are stored in this exact format so they sort and compare as strings.
    """
    t = datetime.now(timezone.utc) - timedelta(hours=delta_hours)
    return t.replace(microsecond=0).isoformat()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(seed_samples):
    db = get_db()
    db.executescript(SCHEMA)
    empty = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0] == 0
    if seed_samples and empty:
        for r in SAMPLE_REPORTS:
            db.execute(
                "INSERT INTO reports (lat, lon, type, road_name, description, source, status, reported_at, sample)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (r["lat"], r["lon"], r["type"], r["road_name"], r["description"],
                 r["source"], r["status"], now_iso(r["hours_ago"])),
            )
    db.commit()


def expire_old_reports():
    """Mark user reports older than REPORT_TTL_HOURS as expired (0 disables)."""
    ttl = current_app.config["REPORT_TTL_HOURS"]
    if not ttl:
        return
    db = get_db()
    db.execute(
        "UPDATE reports SET status = 'expired'"
        " WHERE source = 'user' AND status IN ('pending', 'verified') AND reported_at < ?",
        (now_iso(ttl),),
    )
    db.commit()
