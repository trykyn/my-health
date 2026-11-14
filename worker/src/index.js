// 내 건강 동기화 서버 (Cloudflare Worker, 무료 요금제)
//
// 아이폰 '단축어' 자동화가 Apple Watch 운동이 끝날 때 오늘 기록(운동 시간·활동 칼로리·걸음 수)을 여기로 보내고,
// 건강 앱은 여기서 기록을 읽어 달력에 보여 줌. 인바디·헬스 기록도 같은 곳에 보관해서 휴대폰을 바꿔도 남음.
//
//   POST /h/{키}   { minutes, kcal, steps, types?, date? }   ← 단축어. 그날 값을 덮어씀(같은 날 여러 번 보내도 안전)
//   GET  /d/{키}                                            → { days, inbody, gym }
//   POST /d/{키}   { inbody?, gym?, day? }                   ← 앱. 보낸 항목만 바꿈
//
// 키는 앱이 처음 열릴 때 만든 32자리 무작위 문자열. 키를 아는 사람만 읽고 쓸 수 있음.
// 저장소 (KV): STORE — data:{키} → 위 JSON 하나

const ALLOWED_ORIGINS = ["https://trykyn.github.io", "http://localhost:8768"];
const KEY_RE = /^[A-Za-z0-9]{24,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const [, kind, key] = url.pathname.split("/");
    if (!["h", "d"].includes(kind) || !KEY_RE.test(key || "")) return json({ error: "not_found" }, 404);
    const sk = `data:${key}`;
    const load = async () => (await env.STORE.get(sk, "json")) || { days: {}, inbody: [], gym: {} };

    // 단축어에서 오는 오늘 기록
    if (kind === "h" && request.method === "POST") {
      const body = await readBody(request);
      const date = DATE_RE.test(String(body.date || "")) ? body.date : berlinToday();
      const data = await load();
      const day = { ...(data.days[date] || {}) };
      const min = num(body.minutes), kcal = num(body.kcal);
      // 걸음 수는 항상 정수: "8.432"(독일식 천 단위)도 8432 로
      const steps = body.steps == null || body.steps === "" ? null : num(String(body.steps).replace(/\D/g, ""));
      if (min != null) day.min = Math.round(min);
      if (kcal != null) day.kcal = Math.round(kcal);
      if (steps != null) day.steps = Math.round(steps);
      const types = list(body.types);
      if (types.length) day.types = types;
      day.at = Date.now();
      delete day.manual; // 워치 기록이 오면 직접 고친 표시는 없앰
      data.days[date] = day;
      await env.STORE.put(sk, JSON.stringify(data));
      return new Response(`저장됨 ${date}: ${day.min ?? "-"}분 · ${day.kcal ?? "-"}kcal`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (kind === "d" && request.method === "GET") return json(await load());

    // 앱에서 오는 인바디·헬스 기록
    if (kind === "d" && request.method === "POST") {
      const text = await request.text();
      if (text.length > 500_000) return json({ error: "too_big" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
      const data = await load();
      if (Array.isArray(body.inbody)) data.inbody = body.inbody;
      if (body.gym && typeof body.gym === "object") data.gym = body.gym;
      // 직접 고친 하루 기록 (null 이면 지움)
      if (body.day && DATE_RE.test(body.day.date || "")) {
        if (body.day.value) data.days[body.day.date] = { ...body.day.value, at: Date.now(), manual: true };
        else delete data.days[body.day.date];
      }
      await env.STORE.put(sk, JSON.stringify(data));
      return json(data);
    }
    return json({ error: "not_found" }, 404);
  },
};

// 단축어는 JSON 또는 양식(form)으로 보낼 수 있음
async function readBody(request) {
  const type = request.headers.get("Content-Type") || "";
  try {
    if (type.includes("json")) return await request.json();
    if (type.includes("form")) return Object.fromEntries(await request.formData());
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

// "45", 45, "320,5 kcal", "1.234", "1,234.5" 처럼 어떤 모양이든 숫자로. 없으면 null
function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).replace(/\s/g, "");
  const m = s.match(/-?[\d.,]+/);
  if (!m) return null;
  s = m[0];
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.split(dec === "." ? "," : ".").join("").replace(",", ".");
  } else if (lastComma >= 0) {
    // "1,234" (천 단위) 와 "12,5" (소수) 구분: 쉼표 뒤가 정확히 3자리면 천 단위로 봄
    s = /,\d{3}$/.test(s) && !/,.*,/.test(s.slice(0, -4)) && s.length > 4 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// 운동 종류: 배열이든 줄바꿈/쉼표로 이어진 글자든 목록으로
function list(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[\n,]+/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))].slice(0, 10).map(x => x.slice(0, 40));
}

function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
