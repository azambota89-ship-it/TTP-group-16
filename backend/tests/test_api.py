import db
from routing import get_graph

VALID_REPORT = {"lat": 4.3085, "lon": 101.1530, "type": "impassable", "road_name": "Jalan Test", "description": "deep"}


def test_floods_returns_seeded_active_reports(client):
    floods = client.get("/floods").get_json()
    assert {f["status"] for f in floods} == {"reported", "pending", "verified"}
    for f in floods:
        assert {"id", "lat", "lon", "source", "status", "reported_at", "description"} <= f.keys()


def test_report_server_sets_status_source_and_time(client):
    res = client.post("/reports", json={**VALID_REPORT, "status": "verified", "source": "met",
                                        "reported_at": "2000-01-01T00:00:00+00:00"})
    assert res.status_code == 201
    r = res.get_json()
    assert (r["status"], r["source"]) == ("pending", "user")
    assert not r["reported_at"].startswith("2000")
    assert r["description"] == "Road flooded, impassable (Jalan Test): deep"
    assert r["id"] in [f["id"] for f in client.get("/floods").get_json()]


def test_report_validation(client):
    bad = [
        {**VALID_REPORT, "lat": "4.3"},
        {**VALID_REPORT, "lat": True},
        {**VALID_REPORT, "lat": 3.0},
        {**VALID_REPORT, "type": "tsunami"},
        {**VALID_REPORT, "road_name": "x" * 81},
        {**VALID_REPORT, "description": "x" * 201},
        {**VALID_REPORT, "description": 5},
    ]
    for body in bad:
        assert client.post("/reports", json=body).status_code == 400, body
    assert client.post("/reports", data="nope", content_type="application/json").status_code == 400


def test_old_user_reports_expire(app, client):
    with app.app_context():
        conn = db.get_db()
        conn.execute("UPDATE reports SET reported_at = ? WHERE source = 'user'", (db.now_iso(48),))
        conn.commit()
    statuses = {f["source"]: f["status"] for f in client.get("/floods").get_json()}
    assert statuses == {"met": "reported"}


def test_admin_login(client):
    assert client.post("/admin/login", json={"username": "admin", "password": "wrong"}).status_code == 401
    assert client.post("/admin/login", json={"username": "nobody", "password": "x"}).status_code == 401
    data = client.post("/admin/login", json={"username": "admin", "password": "correct-horse"}).get_json()
    assert data["username"] == "admin" and data["token"]


def test_admin_endpoints_require_token(client):
    for headers in ({}, {"Authorization": "Bearer forged"}):
        assert client.get("/admin/reports", headers=headers).status_code == 401
        assert client.patch("/admin/reports/2", json={"status": "verified"}, headers=headers).status_code == 401
        assert client.delete("/admin/reports/2", headers=headers).status_code == 401


def test_admin_manage_reports(client, auth):
    rid = client.post("/reports", json=VALID_REPORT).get_json()["id"]
    reports = client.get("/admin/reports", headers=auth).get_json()
    mine = next(r for r in reports if r["id"] == rid)
    assert (mine["type"], mine["road_name"], mine["description"]) == ("impassable", "Jalan Test", "deep")

    res = client.patch(f"/admin/reports/{rid}", json={"status": "rejected"}, headers=auth)
    assert res.status_code == 200 and res.get_json()["status"] == "rejected"
    assert rid not in [f["id"] for f in client.get("/floods").get_json()]

    assert client.patch(f"/admin/reports/{rid}", json={"status": "bogus"}, headers=auth).status_code == 400
    assert client.delete(f"/admin/reports/{rid}", headers=auth).status_code == 204
    assert client.delete(f"/admin/reports/{rid}", headers=auth).status_code == 404
    assert client.patch("/admin/reports/9999", json={"status": "verified"}, headers=auth).status_code == 404


def test_official_reports_are_read_only(client, auth):
    met = next(r for r in client.get("/admin/reports", headers=auth).get_json() if r["source"] == "met")
    assert client.patch(f"/admin/reports/{met['id']}", json={"status": "rejected"}, headers=auth).status_code == 400
    assert client.delete(f"/admin/reports/{met['id']}", headers=auth).status_code == 400


def _clear_floods(app):
    with app.app_context():
        conn = db.get_db()
        conn.execute("DELETE FROM reports")
        conn.commit()


def test_route_without_floods(app, client):
    _clear_floods(app)
    body = {"origin": {"lat": 4.3050, "lon": 101.1450}, "destination": {"lat": 4.3200, "lon": 101.1600}}
    data = client.post("/route", json=body).get_json()
    assert data["status"] == "ok"
    assert len(data["path"]) >= 2 and data["distance"] > 0
    assert data["blocked_segments"] == [] and data["rerouted"] is False


def test_route_avoids_reported_flood(app, client):
    _clear_floods(app)
    body = {"origin": {"lat": 4.3050, "lon": 101.1450}, "destination": {"lat": 4.3200, "lon": 101.1600}}
    usual = client.post("/route", json=body).get_json()
    # Put a flood on the middle of the usual route.
    mid = usual["path"][len(usual["path"]) // 2]
    assert client.post("/reports", json={**VALID_REPORT, "lat": mid[0], "lon": mid[1]}).status_code == 201

    data = client.post("/route", json=body).get_json()
    assert data["status"] in ("ok", "no_route")
    if data["status"] == "ok":
        assert data["rerouted"] is True
        assert data["blocked_segments"] and data["preferred_path"]
        assert data["distance"] >= usual["distance"]


def test_route_far_from_road_and_validation(app, client):
    far = {"origin": {"lat": 5.5, "lon": 102.5}, "destination": {"lat": 4.3200, "lon": 101.1600}}
    data = client.post("/route", json=far).get_json()
    assert (data["status"], data["reason"]) == ("no_route", "far_from_road")
    assert client.post("/route", json={"origin": {"lat": 4.3}}).status_code == 400


def test_road_graph_has_main_component(app):
    graph = get_graph(app.config["ROADS_FILE"])
    assert any(n["main"] for n in graph.nodes.values())


def test_serves_frontend(client):
    assert client.get("/").status_code == 200
    assert client.get("/admin").status_code == 200
    assert client.get("/app.js").status_code == 200
