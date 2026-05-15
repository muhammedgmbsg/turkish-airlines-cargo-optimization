# server.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from typing import List, Tuple, Dict, Optional
import pulp
import shutil

# ----------------------------------------------------------------------
# FASTAPI APP + CORS
# ----------------------------------------------------------------------
app = FastAPI(title="Air Cargo Loader", version="1.2.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------------------------------------------------
# Yardımcı: Uygun çözücü (CBC varsa CBC, yoksa GLPK; süre limiti ile)
# ----------------------------------------------------------------------
def _choose_solver(time_limit_sec: int = 50):
    # CBC varsa onu kullan
    if shutil.which("cbc"):
        return pulp.PULP_CBC_CMD(msg=0, timeLimit=time_limit_sec, threads=1)
    # GLPK varsa ona düş
    if shutil.which("glpsol"):
        try:
            return pulp.GLPK_CMD(msg=0, options=["--tmlim", str(time_limit_sec)])
        except Exception:
            return pulp.GLPK_CMD(msg=0)
    # Hiçbiri yoksa None: MIP’i atla
    return None

# ----------------------------------------------------------------------
# Slot üretici: FWD/AFT gerçek uzunluklara göre eşit aralıklı merkezler
# ----------------------------------------------------------------------
def _pairs_to_positions_linear(
    pairs_fwd: int,
    len_fwd_m: float,
    pairs_aft: int,
    len_aft_m: float,
    floor_limit: float,
    door_fwd=("forward",),
    door_aft=("aft",),
    allowed_uld=("AKE", "PMC", "PAG", "PAL"),
    maxw_fwd=5000,
    maxw_mid=6000,
    maxw_aft=5000,
) -> List[Dict]:
    positions: List[Dict] = []

    # FWD taraf (negatif arm)
    if pairs_fwd > 0 and len_fwd_m > 0:
        step_fwd = len_fwd_m / pairs_fwd
        centers_fwd = [-(len_fwd_m - (i + 0.5) * step_fwd) for i in range(pairs_fwd)]
        mid_idx_fwd = pairs_fwd // 2
        for i, arm in enumerate(centers_fwd):
            mw = maxw_mid if i == mid_idx_fwd else maxw_fwd
            for side in ("L", "R"):
                positions.append({
                    "id": f"F{i+1}{side}",
                    "coord": round(float(arm), 3),
                    "side": side,
                    "max_weight": mw,
                    "max_volume": 40,
                    "max_units": 1,
                    "doors": list(door_fwd),
                    "allowed_uld": list(allowed_uld),
                    "floor_limit": floor_limit,
                })

    # AFT taraf (pozitif arm)
    if pairs_aft > 0 and len_aft_m > 0:
        step_aft = len_aft_m / pairs_aft
        centers_aft = [((i + 0.5) * step_aft) for i in range(pairs_aft)]
        mid_idx_aft = pairs_aft // 2
        for i, arm in enumerate(centers_aft):
            mw = maxw_mid if i == mid_idx_aft else maxw_aft
            for side in ("L", "R"):
                positions.append({
                    "id": f"A{i+1}{side}",
                    "coord": round(float(arm), 3),
                    "side": side,
                    "max_weight": mw,
                    "max_volume": 40,
                    "max_units": 1,
                    "doors": list(door_aft),
                    "allowed_uld": list(allowed_uld),
                    "floor_limit": floor_limit,
                })
    return positions

# ----------------------------------------------------------------------
# A330 SPEC
# ----------------------------------------------------------------------
A330_SPEC: Dict = {
    "name": "Airbus A330-300 (Lower Deck 32 LD3)",
    "doors": {
        "forward": {"width_cm": 270, "height_cm": 167},
        "aft":     {"width_cm": 272, "height_cm": 167},
    },
    "positions": _pairs_to_positions_linear(
        pairs_fwd=9,  len_fwd_m=10.19,
        pairs_aft=7,  len_aft_m=12.32,
        floor_limit=659,
        maxw_fwd=5000, maxw_mid=6000, maxw_aft=5000,
    ),
    "cg_limits": (-2.0, 2.0),
    "empty_weight": 80000.0,
    "arm_ref": 0.0,
    "lateral_policy": {"type": "percent_of_payload", "value": 0.05},
    "viz": {"nose_direction": "left", "fuselage_length_m": 30},
}

# ----------------------------------------------------------------------
# B777-300ER SPEC
# ----------------------------------------------------------------------
LD3_PITCH = 1.562
B777_FWD_LEN = LD3_PITCH * 12
B777_AFT_LEN = LD3_PITCH * 10

B777_SPEC: Dict = {
    "name": "Boeing 777-300ER (Lower Deck 44 LD3)",
    "doors": {
        "forward": {"width_cm": 269, "height_cm": 170},
        "aft":     {"width_cm": 269, "height_cm": 170},
    },
    "positions": _pairs_to_positions_linear(
        pairs_fwd=12, len_fwd_m=B777_FWD_LEN,
        pairs_aft=10, len_aft_m=B777_AFT_LEN,
        floor_limit=977,
        maxw_fwd=6000, maxw_mid=8000, maxw_aft=7000,
    ),
    "cg_limits": (-2.0, 2.0),
    "empty_weight": 95000.0,
    "arm_ref": 0.0,
    "lateral_policy": {"type": "percent_of_payload", "value": 0.05},
    "viz": {"nose_direction": "left", "fuselage_length_m": 34},
}

AIRCRAFT_SPECS: Dict[str, Dict] = {
    "a330": A330_SPEC,
    "b777": B777_SPEC,
}

# ----------------------------------------------------------------------
# Modeller
# ----------------------------------------------------------------------
class LoadItem(BaseModel):
    id: str
    weight: float
    length: Optional[float] = None
    width: Optional[float]  = None
    height: Optional[float] = None
    type: Optional[str]     = None   # AKE/PMC/PAG/PAL...
    door: Optional[str]     = None   # "forward" | "aft"

class SolveRequest(BaseModel):
    aircraft: str
    payload: List[LoadItem]

# ----------------------------------------------------------------------
# Yardımcılar
# ----------------------------------------------------------------------
def _vol(L: LoadItem) -> float:
    l = L.length if L.length and L.length > 0 else 1.0
    w = L.width  if L.width  and L.width  > 0 else 1.0
    h = L.height if L.height and L.height > 0 else 1.0
    return l * w * h

def _footprint(L: LoadItem) -> float:
    l = L.length if L.length and L.length > 0 else 1.0
    w = L.width  if L.width  and L.width  > 0 else 1.0
    return l * w

def _lateral_limit(spec: Dict, total_payload: float) -> float:
    pol = spec.get("lateral_policy", {"type": "percent_of_payload", "value": 0.05})
    if pol["type"] == "percent_of_payload":
        return max(0.0, float(pol["value"]) * total_payload)
    return float(pol.get("value", 0.0))

def _door_fits(spec: Dict, L: LoadItem) -> bool:
    if not L.door:
        return True
    door_geo = spec["doors"].get(L.door)
    if not door_geo:
        return False
    dw = door_geo["width_cm"] / 100.0
    dh = door_geo["height_cm"] / 100.0
    return (L.width or 0) <= dw and (L.height or 0) <= dh

# ----------------------------------------------------------------------
# MIP Çözümleyici
# ----------------------------------------------------------------------
def solve_mip(spec: Dict, loads: List[LoadItem]) -> Tuple[list, dict, str]:
    pos = spec["positions"]; nL, nP = len(loads), len(pos)
    prob = pulp.LpProblem("air_cargo_loading", pulp.LpMinimize)

    # Karar değişkenleri
    x = {(i, j): pulp.LpVariable(f"x_{i}_{j}", 0, 1, cat="Binary") for i in range(nL) for j in range(nP)}
    y = {j: pulp.LpVariable(f"y_{j}", 0, 1, cat="Binary") for j in range(nP)}
    z = {i: pulp.LpVariable(f"z_{i}", 0, 1, cat="Binary") for i in range(nL)}  # yük seçildi mi?

    arms = [p["coord"] for p in pos]
    total_moment = pulp.lpSum(loads[i].weight * arms[j] * x[(i, j)] for i in range(nL) for j in range(nP))
    total_weight = pulp.lpSum(loads[i].weight * z[i] for i in range(nL))

    # Amaç: Ağırlığı maksimize et (negatif katsayı), CG sapmasını ve lateral farkı küçült
    Mpos = pulp.LpVariable("Mpos", lowBound=0)
    Mneg = pulp.LpVariable("Mneg", lowBound=0)
    lat_diff = pulp.LpVariable("lat_diff", lowBound=0)
    prob += -1000.0 * total_weight + 1.0 * (Mpos + Mneg) + 0.01 * lat_diff
    prob += total_moment == Mpos - Mneg

    # Her yük en fazla 1 pozisyona: ∑_j x_ij == z_i
    for i in range(nL):
        prob += pulp.lpSum(x[(i, j)] for j in range(nP)) == z[i]

    # Pozisyon kapasiteleri + max_units + x->y linki
    for j, p in enumerate(pos):
        prob += pulp.lpSum(loads[i].weight * x[(i, j)] for i in range(nL)) <= p["max_weight"]
        prob += pulp.lpSum(_vol(loads[i]) * x[(i, j)] for i in range(nL)) <= p["max_volume"]
        prob += pulp.lpSum(x[(i, j)] for i in range(nL)) <= p["max_units"]
        for i in range(nL):
            prob += x[(i, j)] <= y[j]

    # Uyum kontrolleri (ULD, floor, kapı geometri). Kapı->bölme erişimi MIP'te serbest.
    for i in range(nL):
        area = _footprint(loads[i])
        for j, p in enumerate(pos):
            ok = True
            if loads[i].type and loads[i].type not in p["allowed_uld"]:
                ok = False
            if area <= 0 or (loads[i].weight / area) > p["floor_limit"]:
                ok = False
            if not _door_fits(spec, loads[i]):
                ok = False
            # if loads[i].door and (loads[i].door not in p["doors"]):  # erişim serbest istenirse kapalı
            #     ok = False
            if not ok:
                prob += x[(i, j)] == 0

    # CG limitleri (payload+empty toplamına göre)
    ew, arm_ref = spec["empty_weight"], spec["arm_ref"]
    cg_min, cg_max = spec["cg_limits"]
    prob += (ew * arm_ref + total_moment) - cg_min * (ew + total_weight) >= 0
    prob += (ew * arm_ref + total_moment) - cg_max * (ew + total_weight) <= 0

    # Lateral: |W_L - W_R| <= k * total_weight
    W_left  = pulp.lpSum(loads[i].weight * x[(i, j)] for i in range(nL) for j in range(nP) if pos[j]["side"] == "L")
    W_right = pulp.lpSum(loads[i].weight * x[(i, j)] for i in range(nL) for j in range(nP) if pos[j]["side"] == "R")
    prob += W_left - W_right <= lat_diff
    prob += W_right - W_left <= lat_diff
    pol = spec.get("lateral_policy", {"type": "percent_of_payload", "value": 0.05})
    if pol.get("type") == "percent_of_payload":
        k = float(pol.get("value", 0.05))
        prob += lat_diff <= k * total_weight
    else:
        prob += lat_diff <= float(pol.get("value", 0.0))

    # --- ÇÖZ ---
    solver = _choose_solver(time_limit_sec=50)
    if solver is not None:
        prob.solve(solver)
    else:
        # Solver yok: MIP denemeyelim → üst katmana "Not Solved" dön
        return [], {
            "total_moment": 0,
            "total_weight": 0,
            "cg": 0,
            "lateral_diff": 0,
            "lateral_limit": 0
        }, "Not Solved"

    status = pulp.LpStatus[prob.status]

    # Çözümü oku
    placements, total_m, tw = [], 0.0, 0.0
    for i in range(nL):
        for j in range(nP):
            val = pulp.value(x[(i, j)])
            if val is not None and val >= 0.5:
                placements.append({
                    "id": loads[i].id,
                    "position": pos[j]["id"],
                    "weight": loads[i].weight,
                    "type": loads[i].type,
                    "side": pos[j]["side"],
                })
                total_m += loads[i].weight * pos[j]["coord"]
                tw += loads[i].weight

    # Emniyet: aynı id ikinci kez geldiyse tekilleştir
    seen = set()
    unique_placements = []
    for pl in placements:
        if pl["id"] in seen:
            continue
        seen.add(pl["id"])
        unique_placements.append(pl)
    placements = unique_placements

    cg = (ew * arm_ref + total_m) / (ew + tw) if (ew + tw) > 0 else 0.0
    summary = {
        "total_moment": total_m,
        "total_weight": tw,
        "cg": cg,
        "lateral_diff": float(abs(pulp.value(W_left) - pulp.value(W_right))) if pulp.value(W_left) is not None else 0.0,
        "lateral_limit": _lateral_limit(spec, tw),
    }
    return placements, summary, status

# ----------------------------------------------------------------------
# Heuristic (center-first + CG skoru + pairing + duplicate guard)
# ----------------------------------------------------------------------
def solve_greedy_local(spec: Dict, loads: List[LoadItem]) -> Tuple[list, dict, str]:
    pos = spec["positions"]

    # Center-first aday sırası
    by_center = sorted(range(len(pos)),
                       key=lambda j: (abs(pos[j]["coord"]), pos[j]["side"]))

    # Doluluk izleme
    occ_w = {p["id"]: 0.0 for p in pos}
    occ_v = {p["id"]: 0.0 for p in pos}
    occ_u = {p["id"]: 0   for p in pos}
    placements = []
    placed_ids = set()  # << tekrar yerleşmeyi önlemek için

    # Yükleri ağırdan hafife sırala
    loads_sorted = sorted(loads, key=lambda L: -L.weight)

    # İnşa aşaması lateral limiti (gevşetilmiş) + dinamik hesap
    total_target = sum(L.weight for L in loads)
    strict_lat_cap_total = _lateral_limit(spec, total_target)
    build_lat_cap_factor = 1.8  # inşa aşamasında tolerans

    def side_weight(side: str) -> float:
        return sum(pl["weight"] for pl in placements if pl["side"] == side)

    def feasible_on_pos(L: LoadItem, p: Dict) -> bool:
        # ULD
        if L.type and L.type not in p["allowed_uld"]:
            return False
        # floor
        area = _footprint(L)
        if area <= 0 or (L.weight / area) > p["floor_limit"]:
            return False
        # kapı geometri (kapı->bölme erişimi heuristic'te de serbest bırakıldı)
        if not _door_fits(spec, L):
            return False
        # if L.door and (L.door not in p["doors"]):  # erişimi kısıtlamak istersen aç
        #     return False
        # kapasite
        if occ_w[p["id"]] + L.weight > p["max_weight"]:
            return False
        if occ_v[p["id"]] + _vol(L) > p["max_volume"]:
            return False
        if occ_u[p["id"]] + 1 > p["max_units"]:
            return False
        return True

    def cg_if_place(total_m, total_w, ew, arm_ref, Lw, Lcoord):
        tm = total_m + Lw * Lcoord
        tw = total_w + Lw
        return (ew * arm_ref + tm) / (ew + tw) if (ew + tw) > 0 else 0.0

    # anlık toplam moment/ağırlık
    total_m, tw = 0.0, 0.0
    ew, arm_ref = spec["empty_weight"], spec["arm_ref"]

    for L in loads_sorted:
        if L.id in placed_ids:
            continue  # zaten yerleştirildiyse geç

        # anlık lateral limiti (strict) ve inşa limiti (gevşek)
        strict_lat_cap_now = _lateral_limit(spec, tw + L.weight)
        build_lat_cap_now = max(strict_lat_cap_now, build_lat_cap_factor * strict_lat_cap_total)

        # 1) Ağır yüklerde pairing dene
        placed = False
        if L.weight >= 6000:
            best_pair = None
            best_score = None
            for j in by_center:
                p1 = pos[j]
                if not feasible_on_pos(L, p1):
                    continue
                # Aynı arm'ın karşı tarafı (ayna)
                mirror_candidates = [k for k in by_center
                                     if abs(pos[k]["coord"] - p1["coord"]) < 1e-6 and pos[k]["side"] != p1["side"]]
                # Yoksa en yakın |arm| zıt side
                if not mirror_candidates:
                    mirror_candidates = [k for k in by_center if pos[k]["side"] != p1["side"]]
                    mirror_candidates.sort(key=lambda k: abs(pos[k]["coord"] - p1["coord"]))

                for k in mirror_candidates:
                    p2 = pos[k]
                    # İkinci yük adayı bul (henüz yerleşmemiş)
                    pair_idx = None
                    for idx2, L2 in enumerate(loads_sorted):
                        if L2 is L or L2.id in placed_ids:
                            continue
                        if L2.weight >= 6000 and (not L2.type or L2.type in p2["allowed_uld"]) and feasible_on_pos(L2, p2):
                            pair_idx = idx2
                            break
                    if pair_idx is None:
                        continue
                    L2 = loads_sorted[pair_idx]

                    # Lateral kontrol (inşa limiti)
                    wL, wR = side_weight("L"), side_weight("R")
                    newL = wL + (L.weight if p1["side"] == "L" else 0) + (L2.weight if p2["side"] == "L" else 0)
                    newR = wR + (L.weight if p1["side"] == "R" else 0) + (L2.weight if p2["side"] == "R" else 0)
                    if abs(newL - newR) > build_lat_cap_now:
                        continue

                    # CG skoru (çift yerleştirme sonrası)
                    cg_after_first  = cg_if_place(total_m,     tw, ew, arm_ref, L.weight,  p1["coord"])
                    tm2 = total_m + L.weight * p1["coord"]
                    tw2 = tw + L.weight
                    cg_after_second = cg_if_place(tm2, tw2, ew, arm_ref, L2.weight, p2["coord"])
                    score = abs(cg_after_second - 0.0)

                    if (best_score is None) or (score < best_score):
                        best_score = score
                        best_pair = (j, k, pair_idx)

            if best_pair is not None:
                j, k, pair_idx = best_pair
                p1, p2 = pos[j], pos[k]
                L2 = loads_sorted[pair_idx]
                # commit ikisini birden (duplicate guard ile)
                for (LL, pp) in ((L, p1), (L2, p2)):
                    if LL.id in placed_ids:
                        continue
                    occ_w[pp["id"]] += LL.weight
                    occ_v[pp["id"]] += _vol(LL)
                    occ_u[pp["id"]] += 1
                    placements.append({
                        "id": LL.id,
                        "position": pp["id"],
                        "weight": LL.weight,
                        "type": LL.type,
                        "side": pp["side"],
                    })
                    placed_ids.add(LL.id)  # tekrar yerleştirmeyi önle
                    total_m += LL.weight * pp["coord"]
                    tw += LL.weight
                placed = True

        # 2) Tekli yerleştirme (CG skoru ile en iyi pozisyon)
        if not placed and (L.id not in placed_ids):
            best_j = None
            best_score = None
            for j in by_center:
                p = pos[j]
                if not feasible_on_pos(L, p):
                    continue
                # Lateral kontrol (inşa limiti)
                wL, wR = side_weight("L"), side_weight("R")
                newL = wL + (L.weight if p["side"] == "L" else 0)
                newR = wR + (L.weight if p["side"] == "R" else 0)
                if abs(newL - newR) > build_lat_cap_now:
                    continue
                # CG skoru
                cg_new = cg_if_place(total_m, tw, ew, arm_ref, L.weight, p["coord"])
                score = abs(cg_new - 0.0)
                if (best_score is None) or (score < best_score):
                    best_score = score
                    best_j = j

            if best_j is not None:
                p = pos[best_j]
                if L.id not in placed_ids:  # emniyet
                    occ_w[p["id"]] += L.weight
                    occ_v[p["id"]] += _vol(L)
                    occ_u[p["id"]] += 1
                    placements.append({
                        "id": L.id,
                        "position": p["id"],
                        "weight": L.weight,
                        "type": L.type,
                        "side": p["side"],
                    })
                    placed_ids.add(L.id)
                    total_m += L.weight * p["coord"]
                    tw += L.weight

        # 3) Yerleşemedi ise bırak (kısıtları aşmayacağız)

    # Emniyet: aynı id ikinci kez eklenmişse tekilleştir
    seen = set()
    unique_placements = []
    for pl in placements:
        if pl["id"] in seen:
            continue
        seen.add(pl["id"])
        unique_placements.append(pl)
    placements = unique_placements
 # ---------------------------
    # Final tightening: katı lateral limit aşılırsa onarmaya çalış
    # ---------------------------
    def side_total(side: str) -> float:
        return sum(pl["weight"] for pl in placements if pl["side"] == side)

    def coord_of(position_id: str) -> float:
        return next(p["coord"] for p in spec["positions"] if p["id"] == position_id)

    def pos_of(position_id: str) -> Dict:
        return next(p for p in spec["positions"] if p["id"] == position_id)

    while True:
        # anlık toplam payload ve katı lateral limiti (yerleştirilenler üzerinden)
        total_payload_now = sum(pl["weight"] for pl in placements)
        strict_cap = _lateral_limit(spec, total_payload_now)
        wL, wR = side_total("L"), side_total("R")
        diff = abs(wL - wR)

        # limit içindeyse veya hiç yük kalmadıysa bitir
        if diff <= strict_cap or not placements:
            break

        heavy_side = "L" if wL > wR else "R"
        light_side = "R" if heavy_side == "L" else "L"

        # heavy side’daki yükleri merkeze yakın olandan başla
        heavy_items = [pl for pl in placements if pl["side"] == heavy_side]
        heavy_items.sort(key=lambda pl: abs(coord_of(pl["position"])))

        swapped = False
        for pl in heavy_items:
            pos_here = pos_of(pl["position"])
            # Aynı arm’ın karşı tarafı (ayna) var mı?
            mirror = next(
                (p for p in spec["positions"]
                 if abs(p["coord"] - pos_here["coord"]) < 1e-6 and p["side"] == light_side),
                None
            )
            if not mirror:
                continue
            # Ayna pozisyon boş mu?
            if any(pl2["position"] == mirror["id"] for pl2 in placements):
                continue

            # ULD/floor/capacity uygun mu?
            L = next((LL for LL in loads if LL.id == pl["id"]), None)
            if L is None:
                continue
            ok = True
            if L.type and L.type not in mirror["allowed_uld"]:
                ok = False
            area = max(1e-9, (L.length or 1.0) * (L.width or 1.0))
            if (L.weight / area) > mirror["floor_limit"]:
                ok = False
            if L.weight > mirror["max_weight"]:
                ok = False
            if _vol(L) > mirror["max_volume"]:
                ok = False
            # (Kapı->bölme erişimi finalde serbest bırakıldı. İstersen burada kısıtlayabilirsin.)

            if ok:
                # taşı
                pl["position"] = mirror["id"]
                pl["side"] = mirror["side"]
                swapped = True
                break

        if swapped:
            continue  # tekrar ölç, halen aşıyorsak döngü devam etsin

        # Swap mümkün değilse: heavy side’dan en hafif ve en dıştaki yükü çıkar (son çare)
        heavy_items.sort(
            key=lambda pl: (pl["weight"], -abs(coord_of(pl["position"])))
        )
        if heavy_items:
            placements.remove(heavy_items[0])
        else:
            break  # yapacak bir şey kalmadı

    # ---------------------------
    # Özet: tightening sonrası metrikleri baştan hesapla
    # ---------------------------
    ew, arm_ref = spec["empty_weight"], spec["arm_ref"]
    total_m, tw = 0.0, 0.0
    for pl in placements:
        total_m += pl["weight"] * coord_of(pl["position"])
        tw += pl["weight"]

    wL = sum(pl["weight"] for pl in placements if pl["side"] == "L")
    wR = sum(pl["weight"] for pl in placements if pl["side"] == "R")
    cg = (ew * arm_ref + total_m) / (ew + tw) if (ew + tw) > 0 else 0.0
    summary = {
        "total_moment": total_m,
        "total_weight": tw,
        "cg": cg,
        "lateral_diff": abs(wL - wR),
        "lateral_limit": _lateral_limit(spec, tw),
    }
    return placements, summary, "Heuristic"

# ----------------------------------------------------------------------
# API
# ----------------------------------------------------------------------
@app.post("/solve")
async def solve(req: SolveRequest):
    spec = AIRCRAFT_SPECS.get(req.aircraft)
    if not spec:
        return {"error": "Desteklenmeyen uçak tipi"}

    loads = req.payload

    def _solve_sync():
        # Küçük/orta örneklerde önce MIP, gerekirse heuristic fallback
        if len(loads) <= 40:
            placements, summary, status = solve_mip(spec, loads)
            if placements:
                return placements, summary, status
            # MIP başarısızsa heuristic'e düş
            h_pl, h_sum, _ = solve_greedy_local(spec, loads)
            if h_pl:
                return h_pl, h_sum, "HeuristicFallback"
            return [], {"total_moment": 0, "total_weight": 0, "cg": 0, "lateral_diff": 0, "lateral_limit": 0}, "Infeasible"
        # Büyük örneklerde direkt heuristic
        return solve_greedy_local(spec, loads)

    placements, summary, status = await run_in_threadpool(_solve_sync)
    return {"placements": placements, "summary": summary, "aircraft_spec": spec, "status": status}

@app.get("/spec/{ac}")
async def get_spec(ac: str):
    spec = AIRCRAFT_SPECS.get(ac)
    if not spec:
        return {"error": "unknown aircraft"}
    return {
        "name": spec["name"],
        "positions_count": len(spec["positions"]),
        "first_positions": spec["positions"][:6],
    }
