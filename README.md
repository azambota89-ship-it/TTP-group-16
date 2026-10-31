# TTP-group-16
Repo for Flood TTp project
30/10/2026- added frontend folder

"route respond shape" :
{ "status": "ok" | "no_route",
  "path": [[lat, lon], ...],
  "distance": 1234,
  "blocked_segments": [ [[lat, lon], [lat, lon]], ... ] }

For roads= Overpass server
downloaded roads.json in mock cuz overpass server is slow

for azam backend:
POST /reports takes {lat, lon, type, road_name, description}. The server should set reported_at, status: "pending" and source: "user" itself, and never trust the browser for those.
