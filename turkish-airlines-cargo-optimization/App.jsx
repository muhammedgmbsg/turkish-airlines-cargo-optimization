import React, { useMemo, useState } from "react";
import { parseAndValidateJSON } from "./validatePayload";

const ULD_COLOR = { AKE: "#ef4444", PMC: "#3b82f6", PAG: "#10b981", PAL: "#f59e0b" };

export default function App() {
  const [aircraft, setAircraft] = useState("a330");
  const [loads, setLoads] = useState([]);
  const [resp, setResp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jsonText, setJsonText] = useState("");

  // JSON’dan yükleme
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    setJsonText(txt);
  };

  const applyJSON = async () => {
    const result = await parseAndValidateJSON(jsonText);
    if (!result.ok) {
      setError(result.errors.join("\n"));
      setLoads([]);
      setResp(null);
      return;
    }
    setError("");
    setLoads(result.payload);
    // JSON içinde aircraft verilmişse onu da seç
    if (result.aircraft) setAircraft(result.aircraft);
  };

  // Anlık doğrulama (iş kuralları): floor, kapı açıklığı, ULD/kapı uyumu
  const spec = resp?.aircraft_spec || null;

  const liveCheck = useMemo(() => {
    if (!spec) return {};
    const doors = spec.doors || {};
    const positions = spec.positions || [];
    const res = {};
    for (const l of loads) {
      const issues = [];
      // kapı
      if (!l.door || !doors[l.door]) issues.push("Kapı seçimi geçersiz (forward/aft).");
      // ULD tipi erişilebilir bir pozisyonda var mı?
      const supportedSomewhere = positions.some(
        (p) => (!l.door || p.doors.includes(l.door)) && (!l.type || p.allowed_uld.includes(l.type))
      );
      if (!supportedSomewhere) issues.push("Bu kapı için ULD tipi pozisyonlarda desteklenmiyor.");
      // kapı açıklığı
      if (l.door && doors[l.door]) {
        const dw = (doors[l.door].width_cm || 0) / 100;
        const dh = (doors[l.door].height_cm || 0) / 100;
        if ((l.width || 0) > dw) issues.push(`Genişlik kapıyı aşıyor (${(l.width || 0).toFixed(2)}m > ${dw.toFixed(2)}m).`);
        if ((l.height || 0) > dh) issues.push(`Yükseklik kapıyı aşıyor (${(l.height || 0).toFixed(2)}m > ${dh.toFixed(2)}m).`);
      }
      // floor
      const area = Math.max(1e-9, (l.length || 0) * (l.width || 0));
      const kgm2 = (l.weight || 0) / area;
      const fitsFloorSomewhere = positions.some(
        (p) => (!l.door || p.doors.includes(l.door)) && kgm2 <= (p.floor_limit || Infinity)
      );
      if (!fitsFloorSomewhere) {
        const minLimit = positions
          .filter((p) => (!l.door || p.doors.includes(l.door)))
          .reduce((m, p) => Math.min(m, p.floor_limit || Infinity), Infinity);
        issues.push(
          `Zemin yük limiti aşılıyor (≈${Math.round(kgm2)} kg/m²). Min limit: ${
            isFinite(minLimit) ? Math.round(minLimit) : "yok"
          } kg/m².`
        );
      }
      res[l.id || "(id yok)"] = { ok: issues.length === 0, issues, meter: Math.round(kgm2) };
    }
    return res;
  }, [spec, loads]);

  // Çöz
  const solve = async () => {
    setBusy(true);
    setError("");
    setResp(null);
    try {
      const r = await fetch("http://localhost:8000/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aircraft, payload: loads })
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setResp(data);
    } catch (e) {
      setError(e.message || "Sunucu hatası");
    } finally {
      setBusy(false);
    }
  };

  // Görselleştirme verisi
  const positions = useMemo(() => {
    if (!spec?.positions) return [];
    return [...spec.positions].sort((a, b) => a.coord - b.coord);
  }, [spec]);

  const byPos = useMemo(() => {
    const m = {};
    for (const p of resp?.placements || []) (m[p.position] ||= []).push(p);
    return m;
  }, [resp]);

  const W = 1100,
    PAD = 24,
    BAND_H = 56,
    GAP = 12;
  const rows = positions.reduce((acc, p) => {
    const key = `${p.coord}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});
  const rowKeys = Object.keys(rows).sort((a, b) => Number(a) - Number(b));

  const rectFor = (rowIdx, colIdx, item) => {
    const y = PAD + rowIdx * (BAND_H + GAP);
    const rw = Math.max(70, (item.length || 1) * 30);
    const rh = Math.max(34, (item.width || 1) * 28);
    const x = PAD + 120 + colIdx * (rw + 10);
    return { x, y: y + (BAND_H - rh) / 2, w: rw, h: rh };
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Hava Kargo Simülasyonu</h1>
            <p className="text-sm text-gray-600">
              JSON şema doğrulaması + anlık kural kontrolü (kapı, zemin, ULD) • A330 / B777
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select className="border rounded px-2 py-1" value={aircraft} onChange={(e) => setAircraft(e.target.value)}>
              <option value="a330">Airbus A330</option>
              <option value="b777">Boeing 777</option>
            </select>
            <button onClick={solve} disabled={busy} className="bg-green-600 disabled:opacity-60 text-white px-3 py-1 rounded">
              {busy ? "Hesaplanıyor..." : "Simülasyonu Çöz"}
            </button>
          </div>
        </header>

        {/* JSON yükleme */}
        <section className="bg-white p-4 rounded shadow space-y-3">
          <h2 className="font-semibold">Yükleri JSON’dan Al</h2>
          <div className="flex items-center gap-3">
            <input type="file" accept=".json,application/json" onChange={onFile} className="border p-1 rounded" />
            <button onClick={applyJSON} className="bg-blue-600 text-white px-3 py-1 rounded">
              JSON’u Uygula
            </button>
          </div>
          <textarea
            className="w-full h-32 border rounded p-2 text-sm font-mono"
            placeholder='[{"id":"L1","weight":2400,"length":1.562,"width":1.534,"height":1.62,"type":"AKE","door":"forward"}, ...]  veya {"payload":[...]}'
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {error && <p className="text-red-600 whitespace-pre-wrap">{error}</p>}
        </section>

        {/* Yük listesi + anlık doğrulama */}
        {loads.length > 0 && (
          <section className="bg-white p-4 rounded shadow">
            <h2 className="font-semibold mb-3">Yükler</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-gray-600">
                  <tr>
                    <th className="p-2">ID</th>
                    <th className="p-2">W (kg)</th>
                    <th className="p-2">L (m)</th>
                    <th className="p-2">W (m)</th>
                    <th className="p-2">H (m)</th>
                    <th className="p-2">ULD</th>
                    <th className="p-2">Door</th>
                    <th className="p-2">Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {loads.map((l, idx) => {
                    const v = spec ? liveCheck[l.id || "(id yok)"] : null;
                    const ok = v?.ok ?? true;
                    const meter = v?.meter ?? 0;
                    return (
                      <tr key={idx} className="border-t">
                        <td className="p-2">{l.id}</td>
                        <td className="p-2">{l.weight}</td>
                        <td className="p-2">{l.length}</td>
                        <td className="p-2">{l.width}</td>
                        <td className="p-2">{l.height}</td>
                        <td className="p-2">{l.type}</td>
                        <td className="p-2">{l.door}</td>
                        <td className="p-2">
                          <span className={`px-2 py-1 rounded text-white ${ok ? "bg-green-600" : "bg-red-600"}`}>
                            {ok ? "Uygun" : "Uygun Değil"}
                          </span>
                          <span className="ml-2 text-xs text-gray-600">floor≈{meter} kg/m²</span>
                          {!ok && v?.issues?.length > 0 && (
                            <ul className="text-xs text-red-600 mt-1 list-disc list-inside">
                              {v.issues.map((it, i) => (
                                <li key={i}>{it}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Çözüm + görselleştirme */}
        {resp && (
          <section className="bg-white p-4 rounded shadow space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Çözüm Özeti</h2>
              <div className="text-sm text-gray-600">
                Status: <b>{resp.status}</b> | Payload: <b>{resp.summary?.total_weight ?? 0} kg</b> | CG:{" "}
                <b>{(resp.summary?.cg ?? 0).toFixed(3)}</b> | Lateral:{" "}
                <b>
                  {(resp.summary?.lateral_diff ?? 0).toFixed(0)} / {(resp.summary?.lateral_limit ?? 0).toFixed(0)} kg
                </b>
              </div>
            </div>

            <div className="text-sm text-gray-600">
              <b>Kapı ölçüleri:</b>{" "}
              {Object.entries(resp.aircraft_spec?.doors || {}).map(([k, v]) => (
                <span key={k} className="mr-4">
                  {k}: {v.width_cm}×{v.height_cm} cm
                </span>
              ))}
            </div>

            <CargoSVG resp={resp} loads={loads} />
          </section>
        )}
      </div>
    </div>
  );
}

function CargoSVG({ resp, loads }) {
  const positions = useMemo(() => {
    if (!resp?.aircraft_spec?.positions) return [];
    return [...resp.aircraft_spec.positions].sort((a, b) => a.coord - b.coord);
  }, [resp]);

  const byPos = useMemo(() => {
    const m = {};
    for (const p of resp?.placements || []) (m[p.position] ||= []).push(p);
    return m;
  }, [resp]);

  const W = 1100,
    PAD = 24,
    BAND_H = 56,
    GAP = 12;

  const rows = positions.reduce((acc, p) => {
    const key = `${p.coord}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});
  const rowKeys = Object.keys(rows).sort((a, b) => Number(a) - Number(b));

  const rectFor = (rowIdx, colIdx, item) => {
    const y = PAD + rowIdx * (BAND_H + GAP);
    const rw = Math.max(70, (item.length || 1) * 30);
    const rh = Math.max(34, (item.width || 1) * 28);
    const x = PAD + 120 + colIdx * (rw + 10);
    return { x, y: y + (BAND_H - rh) / 2, w: rw, h: rh };
  };

  return (
    <div className="border rounded">
      <svg viewBox={`0 0 ${W} ${PAD + rowKeys.length * (BAND_H + GAP) + PAD}`} width="100%" height="100%">
        <rect x={8} y={8} width={W - 16} height={PAD + rowKeys.length * (BAND_H + GAP)} rx="14" fill="#f8fafc" stroke="#cbd5e1" />
        {rowKeys.map((rk, rowIdx) => {
          const group = rows[rk].sort((a, b) => (a.side === "L" ? -1 : 1));
          const y = PAD + rowIdx * (BAND_H + GAP);
          return (
            <g key={rk}>
              <rect x={PAD} y={y} width={W - PAD * 2} height={BAND_H} fill="#fff" stroke="#e5e7eb" />
              <text x={PAD + 8} y={y + 18} fontSize="12" fill="#64748b">
                Arm {rk} — Pos: {group.map((p) => `${p.id}(${p.side})`).join(", ")}
              </text>
              {group.flatMap((p, idx) =>
                (byPos[p.id] || []).map((pl, k) => {
                  const item = loads.find((L) => L.id === pl.id) || {};
                  const { x, y: yy, w, h } = rectFor(rowIdx, idx * 3 + k, item);
                  const color = ULD_COLOR[pl.type] || "#9ca3af";
                  return (
                    <g key={`${pl.id}-${k}`}>
                      <rect x={x} y={yy} width={w} height={h} fill={color} stroke="#111827" rx="8" />
                      <text x={x + 6} y={yy + 16} fontSize="12" fill="#111827">
                        {pl.id} • {pl.type} • {p.side}
                      </text>
                      <text x={x + 6} y={yy + 32} fontSize="11" fill="#111827">
                        {item.weight ?? pl.weight} kg
                      </text>
                    </g>
                  );
                })
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
