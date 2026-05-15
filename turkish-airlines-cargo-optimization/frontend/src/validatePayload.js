import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

let cachedSchema;
let cachedValidator;

async function tryLoadSchema() {
  try {
    const resp = await fetch("/loads.schema.json", { cache: "no-store" });
    if (!resp.ok) return false;
    const text = await resp.text();
    const trimmed = (text || "").trim();
    if (!trimmed) return false;            // boş içerikse geçme
    cachedSchema = JSON.parse(trimmed);    // JSON değilse try/catch yakalar
    cachedValidator = ajv.compile(cachedSchema);
    return true;
  } catch {
    return false;
  }
}

/** JSON metnini parse + şema (varsa) + ek iş kuralları ile doğrula. */
export default async function parseAndValidateJSON(jsonText) {
  let data;
  try {
    data = JSON.parse((jsonText || "").trim());
  } catch (e) {
    return { ok: false, errors: ["Geçersiz JSON: " + e.message] };
  }

  // Şemayı yalnızca 1 kez (ve hataya dayanıklı biçimde) yüklemeyi dene
  if (!cachedValidator && !cachedSchema) {
    await tryLoadSchema(); // başarısız olsa da devam edeceğiz
  }

  // Şema başarılıysa ona göre doğrula
  if (cachedValidator) {
    const ok = cachedValidator(data);
    if (!ok) {
      const msgs = cachedValidator.errors.map((err) => {
        const path = err.instancePath || "(root)";
        return `${path} ${err.message}`;
      });
      return { ok: false, errors: msgs };
    }
  }

  // Şema yoksa temel kontrollerle devam
  const payload = Array.isArray(data) ? data : data.payload;
  if (!Array.isArray(payload) || payload.length === 0) {
    return { ok: false, errors: ["'payload' dizisi yok ya da boş."] };
  }

  const errors = [];

  // Basit alan kontrolleri
  for (const it of payload) {
    if (!it || typeof it !== "object") { errors.push("Payload içinde geçersiz öğe var."); continue; }
    if (!it.id) errors.push("Bir yükte 'id' eksik.");
    if (!(it.weight > 0)) errors.push(`ID ${it.id || "?"}: 'weight' > 0 olmalı.`);
    if (!it.type) errors.push(`ID ${it.id || "?"}: 'type' gerekli.`);
    if (!it.door) errors.push(`ID ${it.id || "?"}: 'door' gerekli.`);
  }

  // ID benzersizliği
  const seen = new Set(); const dup = [];
  for (const it of payload) {
    if (!it?.id) continue;
    if (seen.has(it.id)) dup.push(it.id);
    seen.add(it.id);
  }
  if (dup.length) errors.push("Tekrarlayan id'ler: " + dup.join(", "));

  if (errors.length) return { ok: false, errors };
  return { ok: true, payload, aircraft: data.aircraft || null };
}
