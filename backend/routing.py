"""Flood-aware routing on OpenStreetMap roads.

Server-side port of frontend/localroute.js: builds a road graph from an Overpass
JSON file, snaps points to the nearest road node, and runs Dijkstra twice (the usual
route and a route avoiding road segments near active floods).
"""
import heapq
import json
import math
import threading

BLOCK_RADIUS_M = 40   # a road segment within this distance of a flood point counts as affected
MAX_SNAP_M = 200      # points farther than this from any road are rejected


def haversine(lat1, lon1, lat2, lon2):
    r, rad = 6371000, math.pi / 180
    d_lat, d_lon = (lat2 - lat1) * rad, (lon2 - lon1) * rad
    x = math.sin(d_lat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(d_lon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def dist_to_segment_m(p_lat, p_lon, a, b):
    kx, ky = 111320 * math.cos(p_lat * math.pi / 180), 110540
    ax, ay = (a["lon"] - p_lon) * kx, (a["lat"] - p_lat) * ky
    bx, by = (b["lon"] - p_lon) * kx, (b["lat"] - p_lat) * ky
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    t = -(ax * dx + ay * dy) / len2 if len2 else 0
    t = max(0.0, min(1.0, t))
    return math.hypot(ax + t * dx, ay + t * dy)


class RoadGraph:
    def __init__(self, data):
        self.nodes = {}   # id -> {"lat", "lon", "main"}
        self.adj = {}     # id -> [(to_id, seg_index)]
        self.segs = []    # {"a", "b", "len", "name"}
        self._build(data)

    def _add_node(self, node_id, geom):
        if node_id not in self.nodes:
            self.nodes[node_id] = {"lat": geom["lat"], "lon": geom["lon"], "main": False}
            self.adj[node_id] = []

    def _build(self, data):
        for way in data.get("elements", []):
            geometry = way.get("geometry") or []
            if way.get("type") != "way" or len(geometry) < 2:
                continue
            tags = way.get("tags") or {}
            name = tags.get("name") or tags.get("ref") or f"unnamed {tags.get('highway', 'road')}"
            reverse = tags.get("oneway") == "-1"
            oneway = tags.get("oneway") in ("yes", "true", "1") or tags.get("junction") == "roundabout"
            forward, backward = not reverse, reverse or not oneway
            way_nodes = way.get("nodes")

            for i in range(1, len(geometry)):
                ga, gb = geometry[i - 1], geometry[i]
                a = way_nodes[i - 1] if way_nodes else f"{ga['lat']},{ga['lon']}"
                b = way_nodes[i] if way_nodes else f"{gb['lat']},{gb['lon']}"
                self._add_node(a, ga)
                self._add_node(b, gb)
                idx = len(self.segs)
                self.segs.append({"a": a, "b": b, "name": name,
                                  "len": haversine(ga["lat"], ga["lon"], gb["lat"], gb["lon"])})
                if forward:
                    self.adj[a].append((b, idx))
                if backward:
                    self.adj[b].append((a, idx))

        # Keep only the largest connected piece, so points never snap to an isolated fragment.
        und = {}
        for s in self.segs:
            und.setdefault(s["a"], []).append(s["b"])
            und.setdefault(s["b"], []).append(s["a"])
        seen, best = set(), []
        for start in und:
            if start in seen:
                continue
            comp = [start]
            seen.add(start)
            i = 0
            while i < len(comp):
                for nb in und[comp[i]]:
                    if nb not in seen:
                        seen.add(nb)
                        comp.append(nb)
                i += 1
            if len(comp) > len(best):
                best = comp
        for node_id in best:
            self.nodes[node_id]["main"] = True

    def blocked_segments(self, floods):
        """Indexes of segments within BLOCK_RADIUS_M of any flood point."""
        blocked = set()
        if not floods:
            return blocked
        # Cheap bounding-box prefilter (~BLOCK_RADIUS_M in degrees) before the exact check.
        pad = BLOCK_RADIUS_M / 110000 * 1.5
        for idx, s in enumerate(self.segs):
            a, b = self.nodes[s["a"]], self.nodes[s["b"]]
            min_lat, max_lat = min(a["lat"], b["lat"]) - pad, max(a["lat"], b["lat"]) + pad
            min_lon, max_lon = min(a["lon"], b["lon"]) - pad, max(a["lon"], b["lon"]) + pad
            for f in floods:
                if min_lat <= f["lat"] <= max_lat and min_lon <= f["lon"] <= max_lon \
                        and dist_to_segment_m(f["lat"], f["lon"], a, b) <= BLOCK_RADIUS_M:
                    blocked.add(idx)
                    break
        return blocked

    def snap(self, lat, lon):
        best_id, best_d = None, math.inf
        for node_id, n in self.nodes.items():
            if not n["main"]:
                continue
            d = haversine(lat, lon, n["lat"], n["lon"])
            if d < best_d:
                best_id, best_d = node_id, d
        return best_id, best_d

    def dijkstra(self, src, dst, blocked=None):
        dist, prev, done = {src: 0.0}, {}, set()
        heap, counter = [(0.0, 0, src)], 1   # counter breaks ties without comparing node ids
        while heap:
            d, _, u = heapq.heappop(heap)
            if u in done:
                continue
            done.add(u)
            if u == dst:
                break
            for to, idx in self.adj.get(u, ()):
                if blocked and idx in blocked:
                    continue
                nd = d + self.segs[idx]["len"]
                if nd < dist.get(to, math.inf):
                    dist[to] = nd
                    prev[to] = (u, idx)
                    heapq.heappush(heap, (nd, counter, to))
                    counter += 1
        if dst not in dist:
            return None
        node_ids, seg_ids, cur = [dst], [], dst
        while cur != src:
            u, idx = prev[cur]
            seg_ids.append(idx)
            node_ids.append(u)
            cur = u
        node_ids.reverse()
        seg_ids.reverse()
        return {"node_ids": node_ids, "seg_ids": seg_ids, "dist": dist[dst]}

    def latlons(self, node_ids):
        return [[self.nodes[i]["lat"], self.nodes[i]["lon"]] for i in node_ids]

    def route(self, origin, destination, floods):
        """origin/destination: {"lat", "lon"}; floods: iterable of {"lat", "lon"}.

        Returns the POST /route response shape agreed in the README, plus the optional
        extras (rerouted, blocked_roads, preferred_path, ...) used by route.js.
        """
        def no_route(reason):
            return {"status": "no_route", "reason": reason, "path": [], "distance": 0, "blocked_segments": []}

        s_id, s_d = self.snap(origin["lat"], origin["lon"])
        t_id, t_d = self.snap(destination["lat"], destination["lon"])
        if s_id is None or t_id is None or s_d > MAX_SNAP_M or t_d > MAX_SNAP_M:
            return no_route("far_from_road")

        blocked = self.blocked_segments(floods)
        preferred = self.dijkstra(s_id, t_id)
        alt = self.dijkstra(s_id, t_id, blocked)
        if not preferred or not alt:
            return no_route("no_path")

        hit = [self.segs[i] for i in preferred["seg_ids"] if i in blocked]
        rerouted = bool(hit)
        result = {
            "status": "ok",
            "path": [[origin["lat"], origin["lon"]], *self.latlons(alt["node_ids"]),
                     [destination["lat"], destination["lon"]]],
            "distance": alt["dist"],
            "blocked_segments": [self.latlons([s["a"], s["b"]]) for s in hit],
            "rerouted": rerouted,
            "blocked_roads": list(dict.fromkeys(s["name"] for s in hit)),
            "note": "calculated on the server from OpenStreetMap data",
        }
        if rerouted:
            result["preferred_path"] = self.latlons(preferred["node_ids"])
            result["preferred_distance"] = preferred["dist"]
        return result


_cache = {}
_lock = threading.Lock()


def get_graph(roads_file):
    """Load and cache the road graph for a given Overpass JSON file."""
    with _lock:
        if roads_file not in _cache:
            with open(roads_file, encoding="utf-8") as f:
                _cache[roads_file] = RoadGraph(json.load(f))
        return _cache[roads_file]
