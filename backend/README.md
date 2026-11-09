# Backend (Flask + SQLite)

Implements every endpoint listed in the main README on `http://localhost:5000` and also serves the frontend
(`/` = map, `/admin` = admin dashboard), so no extra web server is needed.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
ADMIN_PASSWORD=choose-one python app.py              # Windows: set ADMIN_PASSWORD=choose-one && python app.py
python -m pytest                                     # run the tests
```

Then set `USE_MOCK = false` in `frontend/app.js` and `frontend/admin.js` and open http://localhost:5000.

- The database is created at `backend/instance/floods.db` on first run, with the three sample floods.
- The first admin account is `admin` with `ADMIN_PASSWORD` (if not set, a random password is printed once).
  Add or reset admins with `flask --app app create-admin <username>`.

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `GET /floods` | - | Active floods: status `pending`, `verified` or `reported` (official). |
| `POST /reports` | - | `{lat, lon, type, road_name, description}`. `type` is `impassable`, `passable` or `standing`; location must be inside the study area. Server sets `reported_at`, `status: "pending"`, `source: "user"`. Returns 201. |
| `POST /route` | - | `{origin: {lat, lon}, destination: {lat, lon}}`. Dijkstra over `frontend/mock/roads.json`, avoiding road segments within 40 m of an active flood. Same response shape as `localroute.js` (`status`, `path`, `distance`, `blocked_segments`, plus `rerouted`, `blocked_roads`, `preferred_path`, `reason`). |
| `POST /admin/login` | - | `{username, password}` -> `{token, username}`, or 401. Token is valid for 8 hours. |
| `GET /admin/reports` | Bearer token | All reports, every status, with `type` and `road_name`. |
| `PATCH /admin/reports/:id` | Bearer token | `{status}`: `verified`, `rejected`, `expired` or `pending`. |
| `DELETE /admin/reports/:id` | Bearer token | 204 on success. |

Admin endpoints return 401 without a valid token. Official (non-`user`) reports are read only (400).
User reports older than `REPORT_TTL_HOURS` (default 24, `0` = never) are marked `expired` automatically.

Optional environment variables: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SECRET_KEY`, `DATABASE`, `ROADS_FILE`,
`REPORT_TTL_HOURS`, `TOKEN_MAX_AGE` (seconds), `SEED_SAMPLES` (`1`/`0`), `CORS_ORIGINS`, `HOST`, `PORT`.
