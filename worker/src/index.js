// 내 건강 동기화 서버 (Cloudflare Worker, 무료 요금제)
//
// 아이폰 '단축어'가 오늘 운동 시간·걸음 수를 여기로 보내고, 건강 앱은 여기서 기록을 읽음.
// 인바디·헬스·직접 추가한 운동·생리 기록도 같은 곳에 보관해서 휴대폰을 바꿔도 남음.
//
//   POST /h/{키}   { minutes, steps, date? }  ← 단축어. 그날 값을 덮어씀(같은 날 여러 번 보내도 안전)
//                  값은 건강 샘플 목록(한 줄에 하나)이어도 됨 → 모두 더함
//   GET  /d/{키}                              → { days, inbody, gym, mine, cycle, profile }
//   POST /d/{키}   { restore?, inbody?, gym?, gymMeta?, gymSession?, day?, mine?, cycleDays?, profile? }  ← 앱. 보낸 항목만 바꿈
//                  restore = 백업 파일 전체로 바꿈
//                  mine = { date, list: [{ id, name, min?, kcal?, note?, gym? }] } 내가 적은 그날 운동 (빈 목록이면 지움)
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
    const load = async () => ({ days: {}, inbody: [], gym: {}, mine: {}, cycle: {}, ...((await env.STORE.get(sk, "json")) || {}) });

    // 단축어에서 오는 오늘 기록
    if (kind === "h" && request.method === "POST") {
      const rawBody = await readBody(request);
      // 아이폰이 첫 글자를 대문자로 바꿔도 괜찮게 (Steps → steps)
      const body = Object.fromEntries(Object.entries(rawBody || {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
      const date = DATE_RE.test(String(body.date || "")) ? body.date : berlinToday();
      const data = await load();
      const day = { ...(data.days[date] || {}) };
      delete day.kcal; delete day.types; delete day.watch; // 예전 버전이 남긴 값
      const min = num(body.minutes);
      // 걸음 수는 항상 정수: "8.432"(독일식 천 단위)도 8432 로. 줄마다 하나씩 오면 더함
      const steps = body.steps == null || body.steps === "" ? null
        : num((Array.isArray(body.steps) ? body.steps : String(body.steps).split(/[\r\n]+/)).map(x => String(x).replace(/\D/g, "")));
      if (min != null) day.min = Math.round(min);
      if (steps != null) day.steps = Math.round(steps);
      day.at = Date.now();
      delete day.manual; // 워치 기록이 오면 직접 고친 표시는 없앰
      data.days[date] = day;
      await env.STORE.put(sk, JSON.stringify(data));
      return new Response(`저장됨 ${date}: ${day.min ?? "-"}분 · ${day.steps ?? "-"}걸음`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (kind === "d" && request.method === "GET") return json(await load());

    // 앱에서 오는 인바디·헬스·생리 기록
    if (kind === "d" && request.method === "POST") {
      const text = await request.text();
      if (text.length > 2_000_000) return json({ error: "too_big" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
      let data = await load();
      // 백업 파일로 되살리기: 기록 전체를 바꿈
      if (body.restore && typeof body.restore === "object") {
        const r = body.restore, obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
        data = { days: obj(r.days), inbody: Array.isArray(r.inbody) ? r.inbody : [], gym: obj(r.gym), mine: obj(r.mine), cycle: obj(r.cycle), profile: obj(r.profile) };
      }
      if (Array.isArray(body.inbody)) data.inbody = body.inbody;
      if (body.gym && typeof body.gym === "object") data.gym = body.gym;
      // 헬스: 주간 계획·루틴·직접 추가한 운동 이름 (보낸 것만 바꿈)
      if (body.gymMeta && typeof body.gymMeta === "object") {
        data.gym = data.gym || {};
        for (const k of ["plan", "routines", "custom"]) if (body.gymMeta[k] !== undefined) data.gym[k] = body.gymMeta[k];
      }
      // 헬스: 그날 세트 기록 하나 (null 이면 지움)
      if (body.gymSession && DATE_RE.test(body.gymSession.date || "")) {
        data.gym = data.gym || {};
        data.gym.sessions = data.gym.sessions || {};
        if (body.gymSession.value) data.gym.sessions[body.gymSession.date] = body.gymSession.value;
        else delete data.gym.sessions[body.gymSession.date];
      }
      // 내 정보: 키 cm (BMI 계산용), 평소 생리 주기·기간 (기록이 쌓이기 전 예상용). 보낸 것만 바꿈
      if (body.profile && typeof body.profile === "object") {
        const p = { ...(data.profile || {}) }, b = body.profile;
        const pick = (k, lo, hi, digits = 0) => {
          if (!(k in b)) return;
          const v = num(b[k]);
          p[k] = v != null && v >= lo && v <= hi ? Math.round(v * 10 ** digits) / 10 ** digits : undefined;
        };
        pick("height", 80, 250, 1); pick("cycleLen", 15, 60); pick("periodLen", 1, 14);
        data.profile = p;
      }
      // 생리 기록: { 날짜: { f: 0~3 (0 = 생리 아님, 1 적음, 2 보통, 3 많음), s: [증상], n: 메모 } | null }
      if (body.cycleDays && typeof body.cycleDays === "object") {
        data.cycle = data.cycle || {};
        for (const [d, v] of Object.entries(body.cycleDays).slice(0, 400)) {
          if (!DATE_RE.test(d)) continue;
          const e = {};
          if (v && [0, 1, 2, 3].includes(v.f)) e.f = v.f;
          if (v && Array.isArray(v.s) && v.s.length) e.s = v.s.slice(0, 12).map(x => String(x).slice(0, 20));
          if (v && v.n) e.n = String(v.n).slice(0, 300);
          if (Object.keys(e).length) data.cycle[d] = e; else delete data.cycle[d];
        }
      }
      // 내가 직접 추가한 운동 (그날 목록 통째로)
      if (body.mine && DATE_RE.test(body.mine.date || "")) {
        const list = (Array.isArray(body.mine.list) ? body.mine.list : []).slice(0, 30).map(x => ({
          id: String(x.id || "").slice(0, 20), name: String(x.name || "").slice(0, 40),
          min: num(x.min) == null ? undefined : Math.round(num(x.min)),
          kcal: num(x.kcal) == null ? undefined : Math.round(num(x.kcal)), note: x.note ? String(x.note).slice(0, 300) : undefined, gym: x.gym ? true : undefined,
        })).filter(x => x.id && x.name);
        if (list.length) data.mine[body.mine.date] = list; else delete data.mine[body.mine.date];
      }
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
  if (type.includes("multipart")) return Object.fromEntries(await request.formData());
  const raw = await request.text();
  if (type.includes("urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// "45", 45, "320,5 kcal", "1.234", "1,234.5" 처럼 어떤 모양이든 숫자로. 없으면 null
function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  // 단축어는 텍스트 필드에 샘플 여러 개를 한 줄에 하나씩 보냄: "8\n39\n231…" → 줄마다 더함
  if (typeof v === "string" && /[\r\n]/.test(v.trim())) v = v.split(/[\r\n]+/);
  if (Array.isArray(v)) { const xs = v.map(num).filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; }
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


function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
