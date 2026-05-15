// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import parseAndValidateJSON from "./validatePayload";

// Ayrışık ULD renkleri
const ULD_COLOR = {
  AKE: "#ef4444", // kırmızı
  PMC: "#3b82f6", // mavi
  PAG: "#10b981", // yeşil
  PAL: "#f59e0b", // amber
};

export default function App() {
  const [aircraft, setAircraft] = useState("a330");
  const [loads, setLoads] = useState([]);
  const [resp, setResp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jsonText, setJsonText] = useState("");

  // Eski sonucu koru; yeni istek sırasında overlay göstereceğiz
  const showResult = !!resp;

  // Yerleşemeyenler
  const unplaced = useMemo(() => {
    if (!resp || !resp.aircraft_spec) return [];
    return analyzeUnplaced(loads, resp.placements, resp.aircraft_spec);
  }, [resp, loads]);

  // Yükleme sırası map
  const loadOrder = useMemo(() => {
    const m = {};
    const merged = resp?.loading_sequence?.merged || [];
    for (const step of merged) m[step.id] = { order: step.order_global, door: step.door, coord: step.coord };
    return m;
  }, [resp]);

  // Yerleşimleri yükleme sırasına göre sırala
   const placementsSorted = useMemo(() => {
    const pls = Array.isArray(resp?.placements) ? resp.placements : [];
    const positions = Array.isArray(resp?.aircraft_spec?.positions) ? resp.aircraft_spec.positions : [];
    const coordOf = (posId) => positions.find(x => x.id === posId)?.coord ?? 0;
    return [...pls].sort((a, b) => {
     const oa = loadOrder[a.id]?.order ?? Number.POSITIVE_INFINITY;
     const ob = loadOrder[b.id]?.order ?? Number.POSITIVE_INFINITY;
     if (oa !== ob) return oa - ob;
      return coordOf(a.position) - coordOf(b.position);
    });
  }, [resp, loadOrder]);
  

  // JSON içe al
  const onFile = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const txt = await f.text();
    setJsonText(txt);
  };

  const applyJSON = async () => {
    try {
      const result = await parseAndValidateJSON(jsonText);
      if (!result.ok) {
        setError(result.errors.join("\n"));
        setLoads([]); // veriyi sıfırla
        // önceki sonucu SİLME—ekranda kalsın
        return;
      }
      setError("");
      setLoads(result.payload);
      if (result.aircraft) setAircraft(result.aircraft);
    } catch (e) {
      setError(e.message || "JSON okunamadı");
    }
  };

  // Canlı kontrol (kapı geometri, floor, ULD)
  const spec = resp?.aircraft_spec || null;
  const liveCheck = useMemo(() => {
    if (!spec) return {};
    const doors = spec.doors || {};
    const positions = spec.positions || [];
    const res = {};
    for (const l of loads) {
      const issues = [];
      if (l.door && !doors[l.door]) issues.push("Kapı seçimi geçersiz (forward/aft).");

      const supportedSomewhere = positions.some((p) => (!l.type || p.allowed_uld.includes(l.type)));
      if (!supportedSomewhere) issues.push("ULD tipi uçakta desteklenen pozisyon bulunamadı.");

      if (l.door && doors[l.door]) {
        const dw = (doors[l.door].width_cm || 0) / 100;
        const dh = (doors[l.door].height_cm || 0) / 100;
        if ((l.width || 0) > dw) issues.push(`Genişlik kapıyı aşıyor (${(l.width || 0).toFixed(2)}m > ${dw.toFixed(2)}m).`);
        if ((l.height || 0) > dh) issues.push(`Yükseklik kapıyı aşıyor (${(l.height || 0).toFixed(2)}m > ${dh.toFixed(2)}m).`);
      }

      const area = Math.max(1e-9, (l.length || 0) * (l.width || 0));
      const kgm2 = (l.weight || 0) / area;
      const fitsFloorSomewhere = positions.some((p) => kgm2 <= (p.floor_limit || Infinity));
      if (!fitsFloorSomewhere) {
        const minLimit = positions.reduce((m, p) => Math.min(m, p.floor_limit || Infinity), Infinity);
        issues.push(
          `Zemin yük limiti aşılıyor (≈${Math.round(kgm2)} kg/m²). Min limit: ${isFinite(minLimit) ? Math.round(minLimit) : "yok"} kg/m².`
        );
      }
      res[l.id || "(id yok)"] = { ok: issues.length === 0, issues, meter: Math.round(kgm2) };
    }
    return res;
  }, [spec, loads]);

  function analyzeUnplaced(loads, placements, spec) {
    if (!spec) return [];
    const placedIds = new Set((placements || []).map(p => p.id));
    const doors = spec.doors || {};
    const positions = spec.positions || [];
    const out = [];

    for (const L of loads) {
      if (placedIds.has(L.id)) continue;
      const reasons = [];
      if (L.door && !doors[L.door]) reasons.push("Kapı geçersiz (forward/aft).");
      const uldSupportedSomewhere = positions.some(p => (!L.type || p.allowed_uld.includes(L.type)));
      if (!uldSupportedSomewhere) reasons.push("ULD tipi desteklenmiyor.");

      if (L.door && doors[L.door]) {
        const dw = (doors[L.door].width_cm || 0) / 100;
        const dh = (doors[L.door].height_cm || 0) / 100;
        if ((L.width || 0) > dw) reasons.push(`Kapı genişliği yetersiz (${(L.width||0).toFixed(2)}m > ${dw.toFixed(2)}m).`);
        if ((L.height || 0) > dh) reasons.push(`Kapı yüksekliği yetersiz (${(L.height||0).toFixed(2)}m > ${dh.toFixed(2)}m).`);
      }

      const area = Math.max(1e-9, (L.length || 0) * (L.width || 0));
      const kgm2 = (L.weight || 0) / area;
      const fitsFloorSomewhere = positions.some(p => kgm2 <= (p.floor_limit || Infinity));
      if (!fitsFloorSomewhere) {
        const minLimit = positions.reduce((m, p) => Math.min(m, p.floor_limit || Infinity), Infinity);
        reasons.push(`Zemin kg/m² yüksek (≈${Math.round(kgm2)}). Min limit: ${isFinite(minLimit) ? Math.round(minLimit) : "yok"}.`);
      }

      if (reasons.length === 0) reasons.push("Optimizasyon (CG/lateral/kapasite) nedeniyle yerleşmedi.");

      out.push({ id: L.id, weight: L.weight, type: L.type, door: L.door, kgm2: Math.round(kgm2), reasons });
    }
    return out;
  }

  // Çöz — eski sonucu silme, üzerine yaz
  const solve = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("http://localhost:8000/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aircraft, payload: loads })
      });
     if (!r.ok) throw new Error(`HTTP ${r.status}`);
     const data = await r.json();
    if (!data || typeof data !== 'object') throw new Error("Geçersiz yanıt");      if (data.error) throw new Error(data.error);
      setResp(data);
    } catch (e) {
      setError(e.message || "Sunucu hatası");
    } finally {
      setBusy(false);
    }
  };

  // Skorlar
  const summary = resp?.summary || {};
  const cg = Number.isFinite(summary.cg) ? summary.cg : 0;
  const cgBand = resp?.aircraft_spec?.cg_limits || [-2, 2];
  const cgLimit = Math.max(Math.abs(cgBand[0]), Math.abs(cgBand[1])) || 2;
  const cgScore = Math.max(0, 100 - (Math.min(1, Math.abs(cg) / cgLimit) * 100));
  const latDiff = summary.lateral_diff || 0;
  const latLimit = summary.lateral_limit || 1;
  const latScore = Math.max(0, 100 - (Math.min(1, latDiff / latLimit) * 100));
  const fuelEff = Math.round(0.6 * cgScore + 0.4 * latScore);
  const safety  = Math.round(0.5 * cgScore + 0.5 * latScore);

  return (
    <div className="app">
      {/* HEADER */}
      <header className="hdr">
        <div className="hdr-inner">
          <div className="brand">
            <img src="/thy-logo.png" alt="THY" className="logo" />
            <div>
              <h1 className="hdr-title">THY • Kargo Yükleme Simülasyonu</h1>
              <p className="hdr-sub">A330 / B777 • Hibrit
 Akıllı Yükleme Yöntemi (HILM) • CG &amp; Lateral Optimizasyonu</p>
            </div>
          </div>
          <div className="actions">
            <select className="input" value={aircraft} onChange={(e) => setAircraft(e.target.value)}>
              <option value="a330">Airbus A330</option>
              <option value="b777">Boeing 777</option>
            </select>
            <button onClick={solve} disabled={busy || loads.length === 0} className="btn btn-primary">
              {busy ? <span className="spinner" /> : null}
              {busy ? "Hesaplanıyor..." : "Optimize Et"}
            </button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="container">
        {/* JSON GİRİŞ */}
        <section className="card">
          <SectionTitle title="Yükleri JSON’dan Al" subtitle="Dosyadan yükle veya JSON'u yapıştır." />
          <div className="row-gap">
            <input type="file" accept=".json,application/json" onChange={onFile} className="input" />
            <button onClick={applyJSON} className="btn btn-dark">Yük verilerini oku</button>
            {error && <span className="err">{error}</span>}
          </div>
          <textarea
            className="input mono textarea"
            placeholder='[{"id":"L1","weight":2400,"length":1.562,"width":1.534,"height":1.62,"type":"AKE","door":"forward"}, ...]  veya {"payload":[...]}'
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
        </section>

        {/* YÜKLER TABLOSU */}
        {loads.length > 0 && (
          <section className="card">
            <SectionTitle title="Yükler" subtitle="Kapı geometri, zemin limiti ve ULD uyumu anlık kontrol edilir." />
            <DataTable
              columns={["ID", "W (kg)", "L (m)", "W (m)", "H (m)", "ULD", "Door", "Durum"]}
              rows={loads.map((l) => {
                const v = spec ? liveCheck[l.id || "(id yok)"] : null;
                const ok = v?.ok ?? true;
                const meter = v?.meter ?? 0;
                return {
                  key: l.id,
                  cells: [
                    <CellMono key="id" text={l.id} />,
                    l.weight, l.length, l.width, l.height, l.type, l.door,
                    <div className="status" key="status">
                      <StatusPill ok={ok} />
                      <span className="muted">floor≈{meter} kg/m²</span>
                    </div>,
                  ],
                  details: !ok && v?.issues?.length > 0 ? (
                    <ul className="list-compact">
                      {v.issues.map((it, i) => <li key={i}>{it}</li>)}
                    </ul>
                  ) : null,
                };
              })}
            />
          </section>
        )}

        {/* ÖZET + GÖRSEL */}
        {showResult && (
          <section className="card">
            <SectionTitle title="Çözüm Özeti" />
            <SummaryCards
              status={resp.status}
              payloadKg={Math.round(summary.total_weight || 0)}
              cg={cg}
              cgLimit={cgLimit}
              latDiff={Math.round(latDiff)}
              latLimit={Math.round(latLimit)}
              fuelEff={fuelEff}
              safety={safety}
            />

            <div className="muted mt-12">
              <b>Kapı ölçüleri:</b>{" "}
              {Object.entries(resp.aircraft_spec?.doors || {}).map(([k, v]) => (
                <span key={k} className="mr-16">
                  {k}: {v.width_cm}×{v.height_cm} cm
                </span>
              ))}
            </div>

            {resp.placements && resp.placements.length > 0 && (
              <CargoTopView resp={resp} />
            )}

 {placementsSorted.length > 0 && (
              <div className="mt-24">
                <SectionTitle title="Yerleşimler (Yükleme Sırasına Göre)" />
                <DataTable
                  columns={["Sıra", "ULD ID", "Kapı", "Pozisyon", "Side", "Arm", "Tip", "Ağırlık"]}
               rows={placementsSorted.map((p) => {
                 const pos = resp?.aircraft_spec?.positions?.find?.(x => x.id === p.position);
                    const o   = loadOrder[p.id];
                    return {
                      key: p.id,
                      cells: [
                        <b key="order">{o?.order ?? "-"}</b>,
                        <CellMono key="id" text={p.id} />,
                        o?.door ?? "-",
                        p.position,
                              p.side || pos?.side || "-",
             pos?.coord ?? "-",
                        p.type,
                        `${p.weight} kg`,
                      ],
                    };
                  })}
                />
              </div>
            )}

            {unplaced.length > 0 && (
              <div className="mt-24">
                <SectionTitle title={`Yerleşemeyen Yükler (${unplaced.length})`} />
                <DataTable
                  columns={["ID", "W (kg)", "ULD", "Kapı", "floor (≈kg/m²)", "Neden"]}
                  rows={unplaced.map((u) => ({
                    key: u.id,
                    cells: [
                      <CellMono key="id" text={u.id} />,
                      u.weight,
                      u.type,
                      u.door,
                      u.kgm2,
                      <ul className="list-compact red" key="reasons">
                        {u.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>,
                    ],
                  }))}
                />
              </div>
            )}
          </section>
        )}
      </main>

      {/* FOOTER */}
      <footer className="ftr">
        <div className="container ftr-inner">
          <div className="brand">
            <img src="/thy-logo.png" alt="THY" className="logo-sm" />
            <span>Türk Hava Yolları • Kargo</span>
          </div>
          <span>© {new Date().getFullYear()} • Tüm hakları saklıdır</span>
        </div>
      </footer>

      {/* Yalın CSS (Tailwind’siz, @apply’siz) */}
      <style>{css}</style>
    </div>
  );
}

/* ---------- Küçük Bileşenler ---------- */

function SectionTitle({ title, subtitle }) {
  return (
    <div className="mb-6">
      <h2 className="h2">{title}</h2>
      {subtitle && <p className="muted">{subtitle}</p>}
    </div>
  );
}

function CellMono({ text }) {
  return <span className="mono chip">{text}</span>;
}

function StatusPill({ ok }) {
  return <span className={`pill ${ok ? "pill-ok" : "pill-bad"}`}>{ok ? "Uygun" : "Uygun Değil"}</span>;
}

function SummaryCards({ status, payloadKg, cg, cgLimit, latDiff, latLimit, fuelEff, safety }) {
  const cgTone  = Math.abs(cg) < cgLimit * 0.25 ? "good" : Math.abs(cg) < cgLimit * 0.75 ? "warn" : "bad";
  const latTone = latDiff < latLimit * 0.25 ? "good" : latDiff < latLimit * 0.75 ? "warn" : "bad";
  const cgScore = Math.max(0, 100 - (Math.min(1, Math.abs(cg)/cgLimit) * 100));
  const latScore = Math.max(0, 100 - (Math.min(1, latDiff/latLimit) * 100));

  return (
    <div className="grid4">
      <Card>
        <div className="muted-xs">Durum</div>
        <div className="title">{status}</div>
        <div className="mt-12"><GaugePill label="Payload" value={payloadKg.toLocaleString()} unit=" kg" tone="neutral" /></div>
      </Card>

      <Card>
        <div className="muted-xs">CG (Hedef: 0’a yakın)</div>
        <div className="title">{cg.toFixed(3)}</div>
        <div className="row-gap mt-12">
          <GaugePill label="Limit" value={cgLimit.toFixed(1)} unit="" tone="neutral" />
          <GaugePill label="Skor" value={cgScore.toFixed(0)} unit="%" tone={cgTone} />
        </div>
      </Card>

      <Card>
        <div className="muted-xs">Lateral</div>
        <div className="title">{latDiff.toLocaleString()} / {latLimit.toLocaleString()} kg</div>
        <div className="row-gap mt-12">
          <GaugePill label="Limit" value={latLimit.toLocaleString()} unit=" kg" tone="neutral" />
          <GaugePill label="Skor" value={latScore.toFixed(0)} unit="%" tone={latTone} />
        </div>
      </Card>

      <Card>
        <div className="grid-gap">
          <ScoreBar label="Yakıt Verimliliği (tahmini)" percent={fuelEff} />
          <ScoreBar label="Uçuş Güvenliği (tahmini)"   percent={safety} />
        </div>
        <p className="note">*Yüzdeler sezgisel göstergedir; CG ve lateral dengeye göre hesaplanır.</p>
      </Card>
    </div>
  );
}

function Card({ children }) {
  return <div className="card glass">{children}</div>;
}

function GaugePill({ label, value, unit = "", tone = "neutral" }) {
  const cls =
    tone === "good" ? "ok" :
    tone === "warn" ? "warn" :
    tone === "bad"  ? "bad" : "neutral";
  return (
    <div className="gauge">
      <span className="muted-xs">{label}</span>
      <span className={`gauge-val ${cls}`}>{value}{unit}</span>
    </div>
  );
}

function ScoreBar({ label, percent }) {
  const tone = percent >= 80 ? "ok" : percent >= 60 ? "warn" : "bad";
  return (
    <div className="score">
      <div className="score-head">
        <span className="muted-xs">{label}</span>
        <span className="muted-xs">{percent}%</span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function DataTable({ columns, rows }) {
  const hasDetails = rows.some(r => r.details);
  return (
    <div className="tbl">
      <div className="tbl-scroll">
        <table className="tbl-el">
          <thead>
            <tr>
              {columns.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key || idx}>
                {r.cells.map((cell, i) => <td key={i}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasDetails && <div className="tbl-details">{rows.map((r, i) => r.details ? <div key={i}>{r.details}</div> : null)}</div>}
    </div>
  );
}

function CargoTopView({ resp }) {
  const wrapRef = useRef(null);
  const [wrapW, setWrapW] = useState(0);

  useEffect(() => {
    const measure = () => setWrapW(wrapRef.current?.clientWidth || 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const spec = resp?.aircraft_spec || {};
  const positions = (spec.positions || []).slice().sort((a, b) => a.coord - b.coord);
  const viz = spec.viz || {};
  const COLORS = ULD_COLOR;

  const placedByPos = {};
  for (const pl of resp.placements || []) placedByPos[pl.position] = pl;

  const arms = positions.map(p => p.coord);
  const minArm = Math.min(...arms, 0);
  const maxArm = Math.max(...arms, 0);
  const paddingM = 2;
  const minX = minArm - paddingM;
  const maxX = maxArm + paddingM;

  // Kutu/yerleşim ölçüleri (görsel denge için sabit)
  const boxW = 64, boxH = 36, boxGapY = 42;

  // --- DUYARLI ÖLÇEKLEME ---
  // Kapsayıcının sol/sağ boşluğunu ve yazı/legend payını düş
  const sidePaddingPx = 160;
  // Ekran dar ise negatif olmamalı
  const usableW = Math.max(320, (wrapW || 0) - sidePaddingPx);

  // Kollar arası en küçük mesafe → etiket/okunabilirlik için asgari piksel
  const uniqueArms = Array.from(new Set(positions.map(p => p.coord))).sort((a,b)=>a-b);
  let minDelta = Infinity;
  for (let i = 1; i < uniqueArms.length; i++) {
    const d = Math.abs(uniqueArms[i] - uniqueArms[i-1]);
    if (d > 0 && d < minDelta) minDelta = d;
  }
  if (!isFinite(minDelta)) minDelta = 1;

  const MIN_GAP_BETWEEN_ARMS_PX = boxW + 12; // en yakın iki arm arası min piksel
  const spanM = Math.max(1e-6, (maxX - minX));
  // Sığması için gereken px/m
  const fitPxPerM = usableW / spanM;
  // Okunabilirlik için minimum px/m
  const minReadablePxPerM = MIN_GAP_BETWEEN_ARMS_PX / minDelta;
  const pxPerM = Math.max(minReadablePxPerM, fitPxPerM);

  // Artık genişlik = tam sığan
  const fuselageLenPx = spanM * pxPerM;
  const fuselageWidthM = 6;
  const fuselageWidthPx = fuselageWidthM * pxPerM;

  // SVG yüksekliğini içerik oranına göre ayarla (scroll yok)
  const SVG_H = Math.max(380, fuselageWidthPx + 160);
  const SVG_W = Math.ceil(fuselageLenPx + sidePaddingPx);

  const originX = 60;
  const centerY = SVG_H / 2;
  const xForArm = (arm) => originX + (arm - minX) * pxPerM;
  const yForSide = (side) => (side === "L" ? centerY - boxGapY - boxH/2 : centerY + boxGapY - boxH/2);
  const noseLeft = (viz.nose_direction || "left") === "left";

  return (
    <div className="viz" ref={wrapRef}>
      <h3 className="h3">Uçak Üstten Görünüm (Arm, L/R, ULD)</h3>
      {/* viewBox + yüzde genişlik: her ekranda taşmadan tam sığar, scroll yok */}
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x="0" y="0" width={SVG_W} height={SVG_H} rx="16" fill="#0b1220" opacity="0.35" />
        <rect
          x={originX}
          y={centerY - fuselageWidthPx/2}
          width={fuselageLenPx}
          height={fuselageWidthPx}
          rx={fuselageWidthPx/2}
          fill="#ffffff10"
          stroke="#e11d2e"
          strokeWidth="1.5"
        />

        {noseLeft ? (
          <>
            <polygon points={`${originX-18},${centerY} ${originX-2},${centerY-8} ${originX-2},${centerY+8}`} fill="#ef4444" />
            <text x={originX-22} y={centerY-14} fontSize="12" fill="#ef4444" textAnchor="end">NOSE</text>
            <text x={originX+fuselageLenPx+10} y={centerY+14} fontSize="12" fill="#cbd5e1">TAIL</text>
          </>
        ) : (
          <>
            <polygon points={`${originX+fuselageLenPx+18},${centerY} ${originX+fuselageLenPx+2},${centerY-8} ${originX+fuselageLenPx+2},${centerY+8}`} fill="#ef4444" />
            <text x={originX+fuselageLenPx+22} y={centerY-14} fontSize="12" fill="#ef4444">NOSE</text>
            <text x={originX-10} y={centerY+14} fontSize="12" fill="#cbd5e1" textAnchor="end">TAIL</text>
          </>
        )}

        {/* Arm kılavuzları */}
        {(() => {
          let lastLabelX = -Infinity;
          const MIN_LABEL_GAP = 38;
          return uniqueArms.map((arm) => {
            const x = xForArm(arm);
            const showLabel = (x - lastLabelX) >= MIN_LABEL_GAP;
            if (showLabel) lastLabelX = x;
            return (
              <g key={`arm-${arm}`}>
                <line
                  x1={x}
                  y1={centerY - fuselageWidthPx/2 - 20}
                  x2={x}
                  y2={centerY + fuselageWidthPx/2 + 20}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  opacity="0.7"
                />
                {showLabel && (
                  <text x={x} y={centerY - fuselageWidthPx/2 - 26} fontSize="11" fill="#cbd5e1" textAnchor="middle">
                    Arm {arm >= 0 ? `+${arm}` : arm}
                  </text>
                )}
              </g>
            );
          });
        })()}

        {/* Pozisyon kutuları */}
        {positions.map((p) => {
          const x = xForArm(p.coord) - (boxW/2);
          const y = yForSide(p.side);
          const pl = placedByPos[p.id];
          const has = !!pl;
          const fill = has ? (COLORS[pl.type] || "#ef4444") : "#ffffff18";
          const stroke = has ? "#0b0f19" : "#94a3b8";
          const title = has
            ? `${pl.id} • ${pl.type} • ${p.id} ${p.side} • ${pl.weight} kg • Arm ${p.coord}`
            : `${p.id} ${p.side} • Arm ${p.coord}`;

          return (
            <g key={p.id} className={has ? "drop" : ""}>
              <rect x={x} y={y} width={boxW} height={boxH} rx="8" fill={fill} stroke={stroke} opacity={has ? 0.98 : 0.5} />
              {has ? (
                <>
                  <text x={x + boxW/2} y={y + 14} fontSize="11" fontWeight="600" fill="#0b0f19" textAnchor="middle">
                    {pl.id}
                  </text>
                  <text x={x + boxW/2} y={y + 26} fontSize="10" fill="#0b0f19" textAnchor="middle">
                    {pl.weight} kg
                  </text>
                </>
              ) : (
                <>
                  <text x={x + boxW/2} y={y + 14} fontSize="11" fill="#e2e8f0" textAnchor="middle">
                    {p.id} {p.side}
                  </text>
                  <text x={x + boxW/2} y={y + 26} fontSize="10" fill="#cbd5e1" textAnchor="middle">
                    Arm {p.coord >= 0 ? `+${p.coord}` : p.coord}
                  </text>
                </>
              )}
              <title>{title}</title>
            </g>
          );
        })}

        {/* Legend */}
        <g>
          <rect x={originX} y={SVG_H - 38} width={260} height={26} fill="#ffffff10" stroke="#e5e7eb1a" rx="8" />
          {["AKE","PMC","PAG","PAL"].map((t, i) => (
            <g key={t}>
              <rect x={originX + 10 + i*60} y={SVG_H - 34} width={18} height={18} fill={ULD_COLOR[t] || "#ef4444"} stroke="#0b0f19" rx="4" />
              <text x={originX + 34 + i*60} y={SVG_H - 20} fontSize="12" fill="#e2e8f0">{t}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}


/* ---------- Stil ---------- */
const css = `
:root{
  --bg:#070a13;
  --bg2:#0b1220;
  --card:#101827cc;
  --border:#1f2937;
  --text:#e5e7eb;
  --muted:#9ca3af;
  --thy:#e11d2e; /* THY kırmızısı */
  --green:#10b981; --amber:#f59e0b; --red:#ef4444;
}
/* kartların normal sınırı kalsın; wide ile tam genişlik */
.card{ width:100%; max-width:1120px; }

.card.wide{
  max-width:100%;
}

/* tablo ve viz kapsayıcısı gerçekten tam genişlik */
.section-full {
  width: 100%;
}

/* tablo elemanları tam genişliğe uyum sağlasın */
.tbl, .tbl-scroll, .tbl-el { width: 100%; }

*{box-sizing:border-box}
html,body,#root{height:100%}

html, body { height: 100%; }
body{
  margin:0;
  background:#0b1220; /* taban renk */
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
  position: relative;
}

/* degrade her zaman tüm viewport’u kaplasın */
body::before{
  content:"";
  position: fixed;
  inset: 0;
  z-index: -1;
  background: radial-gradient(1200px 800px at 10% 10%, #111827 0%, #0b1220 35%, #070a13 100%);
}

/* uygulama alanı tam ekran yüksekliği kullansın */
.app{ min-height: 100dvh; display:flex; flex-direction:column; }

/* footer’ın kendi koyu zeminini şeffaflaştır ki tek arka plan görülsün */
.ftr{ background: transparent; }
.container,
.container-fluid,
.app {
  width: 100%;
  max-width: none;   /* kritik: sınırı kaldır */
  margin: 0;         /* ortalamayı bırak */
  padding: 0;        /* gerekirse bölüm içlerinde padding ver */
}

/* Flex/grid kullanan layoutlarda */
.row { display: flex; }
.col { flex: 1 1 0; min-width: 0; } /* min-width:0 taşmaları önler */

/* kartların genişliğini kontrollü yapalım, taşma olmasın */
.card{ width:100%; max-width:1120px; }

/* viz: artık scroll yok, svg zaten yüzde genişlik */
.viz{
  margin-top:18px;
  border:1px solid rgba(255,255,255,.08);
  background:rgba(255,255,255,.04);
  border-radius:16px;
  padding:14px;
  box-shadow:0 10px 25px rgba(0,0,0,.25);
  overflow:hidden; /* önemli: yatay scroll kalksın */
}

/* SVG tam genişlik */
.viz svg{ display:block; width:100%; height:auto; }

/* JSON textarea sabit boyut + resize kapalı */
.textarea{ width:100%; height:220px; min-height:220px; max-height:220px; resize:none; }

/* header sticky olduğu için arka plan "değişmiş" gibi görünmesin */
.hdr{ position:sticky; top:0; z-index:40; background:rgba(7,10,19,.85); backdrop-filter:blur(10px);
      border-bottom:1px solid rgba(255,255,255,.08) }
.app{ min-height:100vh; display:flex; flex-direction:column; }
.container{max-width:1120px;margin:0 auto;padding:32px 16px;}
.mt-12{margin-top:12px}.mt-24{margin-top:24px}
.mt-6{margin-top:24px}
.mr-16{margin-right:16px}

.hdr{position:sticky;top:0;z-index:40;background:rgba(7,10,19,.75);backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,.08)}
.hdr-inner{max-width:1120px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px}
.logo{height:28px;width:auto;display:block}
.logo-sm{height:20px;width:auto;display:block}
.hdr-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.1px}
.hdr-sub{margin:0;color:var(--muted);font-size:11px}

.actions{display:flex;align-items:center;gap:8px}

.card{background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:18px; box-shadow:0 10px 30px rgba(0,0,0,.25)}
.glass{backdrop-filter: blur(6px)}
.row-gap{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.grid-gap{display:grid;gap:12px}

.h2{margin:0 0 4px 0;font-size:18px;font-weight:600}
.h3{margin:8px 0 8px 0;font-size:16px;font-weight:600}
.title{font-size:18px;font-weight:700}
.mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace}
.muted{color:var(--muted);font-size:13px}
.muted-xs{color:var(--muted);font-size:12px}
.note{color:var(--muted);font-size:11px;margin-top:8px}

.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 14px;font-weight:600;cursor:pointer;background:#151a24;color:#fff;transition:.2s ease all}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(0,0,0,.25)}
.btn:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none}
.btn-primary{background:var(--thy);border-color:#b51b29}
.btn-dark{background:#0f172a;border-color:#1f2937}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.input{background:#0b1220;border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;padding:10px 12px;font-size:13px;min-width:220px;outline:none}
.input:focus{box-shadow:0 0 0 2px rgba(225,29,46,.35)}
.textarea{width:100%;min-height:140px}

.tbl{overflow:hidden;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);box-shadow:0 10px 25px rgba(0,0,0,.25)}
.tbl-scroll{overflow:auto}
.tbl-el{width:100%;border-collapse:separate;border-spacing:0}
.tbl-el thead th{position:sticky;top:0;background:rgba(7,10,19,.85);backdrop-filter:blur(6px);text-align:left;padding:10px 12px;font-weight:700;color:#e5e7eb;font-size:13px;border-bottom:1px solid rgba(255,255,255,.08)}
.tbl-el tbody td{padding:10px 12px;font-size:13px;border-top:1px solid rgba(255,255,255,.05);vertical-align:top}
.tbl-el tbody tr:nth-child(even){background:rgba(255,255,255,.02)}
.tbl-el tbody tr:hover{background:rgba(225,29,46,.08)}
.tbl-details{padding:10px;background:#0b1220;border-top:1px solid rgba(255,255,255,.08);font-size:13px}
.chip{background:#0b1220;border:1px solid rgba(255,255,255,.12);padding:2px 6px;border-radius:6px}

.status{display:flex;align-items:center;gap:8px}
.pill{padding:3px 8px;border-radius:999px;font-size:11px;color:#fff;box-shadow:0 0 0 0 rgba(16,185,129,.0); transition:box-shadow .3s ease}
.pill-ok{background:#10b981; animation:glow 2s ease-out infinite}
.pill-bad{background:#ef4444}
@keyframes glow{0%{box-shadow:0 0 0 0 rgba(16,185,129,.45)}70%{box-shadow:0 0 0 12px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}

.gauge{display:flex;align-items:center;gap:8px}
.gauge-val{padding:4px 8px;border-radius:8px;font-size:12px;color:#fff}
.gauge-val.neutral{background:#334155}
.gauge-val.ok{background:#10b981}
.gauge-val.warn{background:#f59e0b}
.gauge-val.bad{background:#ef4444}

.score{display:grid;gap:6px}
.score-head{display:flex;align-items:center;justify-content:space-between}
.bar{height:8px;background:#111827;border-radius:999px;overflow:hidden}
.bar-fill{height:100%}
.bar-fill.ok{background:#10b981}
.bar-fill.warn{background:#f59e0b}
.bar-fill.bad{background:#ef4444}

.viz{margin-top:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);border-radius:16px;padding:14px;box-shadow:0 10px 25px rgba(0,0,0,.25);overflow:auto}
.drop{animation:drop .35s ease-out both}
@keyframes drop{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}

.ftr{border-top:1px solid rgba(255,255,255,.08);background:rgba(7,10,19,.6)}
.ftr-inner{display:flex;align-items:center;justify-content:space-between;padding:18px 0;color:#9ca3af}
.ftr .brand{gap:8px}

.err{color:#fca5a5;font-size:13px}

@media (max-width: 960px){
  .grid4{grid-template-columns:1fr 1fr}
}
@media (max-width: 640px){
  .grid4{grid-template-columns:1fr}
  .hdr-inner{gap:10px}
  .actions{gap:6px}
  .input{min-width:unset}
}/* ===== FULL BLEED ZORLAYICI OVERRIDES — EN ALTA EKLE ===== */

/* Tüm kökler tam genişlik */
html, body, #root, .app { width: 100%; max-width: none !important; margin: 0 !important; }

/* Container ailesi ve header içi: sabit max-width'i iptal et */
:where(.container, .container-fluid, .hdr-inner) {
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding-inline: 16px; /* kenar boşluğu istersen */
}

/* Kartlar: default tam genişlik */
.card { width: 100% !important; max-width: none !important; }
/* Dar görünmesini istediklerine .narrow ekle */
.card.narrow { max-width: 1120px !important; margin-inline: auto !important; }

/* Bölümler ve tablolar kenardan kenara */
.section-full, .tbl, .tbl-scroll, .tbl-el { width: 100% !important; }

/* Viz alanı taşmadan ölçeklensin */
.viz { overflow: hidden !important; }
.viz svg { display: block; width: 100% !important; height: auto !important; }

/* Flex/grid sütunları taşma yapmasın */
.col { min-width: 0 !important; }

/* Olası yatay taşma/scroll bar kaynaklı sahte boşlukları gizle */
html, body { overflow-x: hidden; }
/* Sayfa iskeleti */
html, body, #root { height: 100%; }
.app { min-height: 100vh; display: flex; flex-direction: column; }

/* Sticky footer: içeriğin altına itilir, sayfa kısa ise dibe yapışır */
.ftr { margin-top: auto; }

/* (İsteğe bağlı) footer içi genişlik */
.ftr-inner { width: 100%; max-width: none; padding: 18px 16px; }

`;
