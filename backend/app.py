"""Flood route backend (Flask + SQLite).

Run:  python app.py            (http://localhost:5000)
See the "Backend" section of the project README for setup and endpoints.
"""
import math
import os
import secrets
from functools import wraps

import click
from flask import Flask, abort, current_app, jsonify, request, send_from_directory
from flask_cors import CORS
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

import db
import routing

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")

# [[south, west], [north, east]], same as STUDY_AREA in frontend/app.js
STUDY_AREA = [[4.290, 101.125], [4.335, 101.175]]

REPORT_TYPES = {
    "impassable": "Road flooded, impassable",
    "passable": "Water over road, passable with care",
    "standing": "Standing water after heavy rain",
}
ADMIN_STATUSES = {"pending", "verified", "rejected", "expired"}
PUBLIC_STATUSES = ("pending", "verified", "reported")
ROAD_NAME_MAX, DESCRIPTION_MAX = 80, 200


def _load_secret_key(instance_path):
    """SECRET_KEY env var, else a random key persisted in instance/secret_key."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(instance_path, "secret_key")
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(secrets.token_hex(32))
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def create_app(test_config=None):
    app = Flask(__name__, instance_path=os.path.join(BASE_DIR, "instance"),
                static_folder=FRONTEND_DIR, static_url_path="")
    os.makedirs(app.instance_path, exist_ok=True)
    app.config.update(
        DATABASE=os.environ.get("DATABASE", os.path.join(app.instance_path, "floods.db")),
        ROADS_FILE=os.environ.get("ROADS_FILE", os.path.join(FRONTEND_DIR, "mock", "roads.json")),
        REPORT_TTL_HOURS=float(os.environ.get("REPORT_TTL_HOURS", "24")),
        TOKEN_MAX_AGE=int(os.environ.get("TOKEN_MAX_AGE", str(8 * 3600))),
        SEED_SAMPLES=os.environ.get("SEED_SAMPLES", "1") == "1",
        ADMIN_USERNAME=os.environ.get("ADMIN_USERNAME", "admin"),
        ADMIN_PASSWORD=os.environ.get("ADMIN_PASSWORD"),
        CORS_ORIGINS=os.environ.get("CORS_ORIGINS", "*"),
    )
    if test_config:
        app.config.update(test_config)
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = _load_secret_key(app.instance_path)

    CORS(app, origins=app.config["CORS_ORIGINS"].split(","))
    app.teardown_appcontext(db.close_db)

    with app.app_context():
        db.init_db(app.config["SEED_SAMPLES"])
        _ensure_admin(app)

    _register_routes(app)
    _register_cli(app)
    return app


# ---------- Admin accounts / tokens ----------
def _set_admin_password(username, password):
    conn = db.get_db()
    conn.execute(
        "INSERT INTO admins (username, password_hash) VALUES (?, ?)"
        " ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash",
        (username, generate_password_hash(password)),
    )
    conn.commit()


def _ensure_admin(app):
    """Create the first admin account if none exists."""
    conn = db.get_db()
    if conn.execute("SELECT COUNT(*) FROM admins").fetchone()[0]:
        return
    username = app.config["ADMIN_USERNAME"]
    password = app.config["ADMIN_PASSWORD"]
    if not password:
        password = secrets.token_urlsafe(9)
        print(f"\n*** Created admin account '{username}' with password: {password}\n"
              "*** Save it now, or set ADMIN_PASSWORD / run `flask --app app create-admin` to change it.\n",
              flush=True)
    _set_admin_password(username, password)


def _serializer(app):
    return URLSafeTimedSerializer(app.config["SECRET_KEY"], salt="admin-auth")


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            abort(401)
        try:
            data = _serializer(current_app).loads(header[7:], max_age=current_app.config["TOKEN_MAX_AGE"])
        except (BadSignature, SignatureExpired):
            abort(401)
        row = db.get_db().execute("SELECT 1 FROM admins WHERE username = ?", (data.get("u"),)).fetchone()
        if row is None:
            abort(401)
        return view(*args, **kwargs)
    return wrapper


# ---------- Helpers ----------
def _number(value):
    """Return value as a finite float, or None (bools are rejected)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _point(obj):
    if not isinstance(obj, dict):
        return None
    lat, lon = _number(obj.get("lat")), _number(obj.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return {"lat": lat, "lon": lon}


def _in_study_area(p):
    (s, w), (n, e) = STUDY_AREA
    return s <= p["lat"] <= n and w <= p["lon"] <= e


def _bad_request(message):
    return jsonify({"error": message}), 400


def _public_description(row):
    """Readable text for the map popup, e.g. "Road flooded, impassable (Jalan X): details"."""
    if row["source"] != "user" or row["type"] not in REPORT_TYPES:
        return row["description"]
    text = REPORT_TYPES[row["type"]]
    if row["road_name"]:
        text += f" ({row['road_name']})"
    if row["description"]:
        text += f": {row['description']}"
    return text


def _report_json(row, public=False):
    return {
        "id": row["id"],
        "lat": row["lat"],
        "lon": row["lon"],
        "source": row["source"],
        "status": row["status"],
        "reported_at": row["reported_at"],
        "type": row["type"],
        "road_name": row["road_name"],
        "description": _public_description(row) if public else row["description"],
        "sample": bool(row["sample"]),
    }


def _active_floods():
    db.expire_old_reports()
    placeholders = ",".join("?" * len(PUBLIC_STATUSES))
    return db.get_db().execute(
        f"SELECT * FROM reports WHERE status IN ({placeholders}) ORDER BY reported_at DESC",
        PUBLIC_STATUSES,
    ).fetchall()


def _get_report_or_404(report_id):
    row = db.get_db().execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if row is None:
        abort(404)
    return row


# ---------- Routes ----------
def _register_routes(app):
    @app.errorhandler(HTTPException)
    def http_error(err):
        return jsonify({"error": err.name.lower()}), err.code

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/admin")
    def admin_page():
        return send_from_directory(FRONTEND_DIR, "admin.html")

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    # ----- Public -----
    @app.get("/floods")
    def list_floods():
        return jsonify([_report_json(r, public=True) for r in _active_floods()])

    @app.post("/reports")
    def create_report():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _bad_request("expected a JSON object")
        point = _point(body)
        if point is None:
            return _bad_request("lat and lon must be numbers")
        if not _in_study_area(point):
            return _bad_request("location is outside the study area")
        report_type = body.get("type")
        if report_type not in REPORT_TYPES:
            return _bad_request(f"type must be one of: {', '.join(REPORT_TYPES)}")
        road_name, description = body.get("road_name") or "", body.get("description") or ""
        if not isinstance(road_name, str) or not isinstance(description, str):
            return _bad_request("road_name and description must be text")
        road_name, description = road_name.strip(), description.strip()
        if len(road_name) > ROAD_NAME_MAX:
            return _bad_request(f"road_name is longer than {ROAD_NAME_MAX} characters")
        if len(description) > DESCRIPTION_MAX:
            return _bad_request(f"description is longer than {DESCRIPTION_MAX} characters")

        # status, source and reported_at are always set here, never taken from the request.
        conn = db.get_db()
        cur = conn.execute(
            "INSERT INTO reports (lat, lon, type, road_name, description, source, status, reported_at)"
            " VALUES (?, ?, ?, ?, ?, 'user', 'pending', ?)",
            (point["lat"], point["lon"], report_type, road_name, description, db.now_iso()),
        )
        conn.commit()
        return jsonify(_report_json(_get_report_or_404(cur.lastrowid), public=True)), 201

    @app.post("/route")
    def find_route():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _bad_request("expected a JSON object")
        origin, destination = _point(body.get("origin")), _point(body.get("destination"))
        if origin is None or destination is None:
            return _bad_request("origin and destination must be {lat, lon} objects")
        graph = routing.get_graph(app.config["ROADS_FILE"])
        floods = [{"lat": r["lat"], "lon": r["lon"]} for r in _active_floods()]
        return jsonify(graph.route(origin, destination, floods))

    # ----- Admin -----
    @app.post("/admin/login")
    def admin_login():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return _bad_request("expected a JSON object")
        username, password = body.get("username"), body.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            abort(401)
        row = db.get_db().execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
        if row is None or not check_password_hash(row["password_hash"], password):
            abort(401)
        token = _serializer(app).dumps({"u": row["username"]})
        return jsonify({"token": token, "username": row["username"]})

    @app.get("/admin/reports")
    @admin_required
    def admin_list_reports():
        db.expire_old_reports()
        rows = db.get_db().execute("SELECT * FROM reports ORDER BY reported_at DESC").fetchall()
        return jsonify([_report_json(r) for r in rows])

    @app.patch("/admin/reports/<int:report_id>")
    @admin_required
    def admin_update_report(report_id):
        row = _get_report_or_404(report_id)
        body = request.get_json(silent=True)
        status = body.get("status") if isinstance(body, dict) else None
        if status not in ADMIN_STATUSES:
            return _bad_request(f"status must be one of: {', '.join(sorted(ADMIN_STATUSES))}")
        if row["source"] != "user":
            return _bad_request("official data is read only")
        conn = db.get_db()
        conn.execute("UPDATE reports SET status = ? WHERE id = ?", (status, report_id))
        conn.commit()
        return jsonify(_report_json(_get_report_or_404(report_id)))

    @app.delete("/admin/reports/<int:report_id>")
    @admin_required
    def admin_delete_report(report_id):
        row = _get_report_or_404(report_id)
        if row["source"] != "user":
            return _bad_request("official data is read only")
        conn = db.get_db()
        conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
        conn.commit()
        return "", 204


def _register_cli(app):
    @app.cli.command("create-admin")
    @click.argument("username")
    @click.password_option()
    def create_admin(username, password):
        """Create an admin account, or reset its password."""
        _set_admin_password(username, password)
        click.echo(f"Admin '{username}' saved.")


if __name__ == "__main__":
    create_app().run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
