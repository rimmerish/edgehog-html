const MAX_MAPS = 50;
const MAX_SCORE = 5000;

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : origin === allowed ? origin : allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, init = {}, request, env) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      ...(init.headers || {}),
    },
  });
}

function cleanInitials(value) {
  return String(value || "AAA")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3) || "AAA";
}

function stageSeed(map) {
  return 12345 + map * 101;
}

function validInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/api/scores" && request.method === "GET") {
      const map = Number(url.searchParams.get("map") || 0);
      if (!validInteger(map) || map < 0 || map >= MAX_MAPS) {
        return json({ error: "Bad map" }, { status: 400 }, request, env);
      }

      const results = await env.DB.prepare(
        `SELECT initials, score, map, seed, created_at
         FROM scores
         WHERE map = ?
         ORDER BY score DESC, created_at ASC
         LIMIT 20`
      ).bind(map).all();

      return json(results.results || [], {}, request, env);
    }

    if (url.pathname === "/api/scores" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Bad JSON" }, { status: 400 }, request, env);
      }

      const initials = cleanInitials(body.initials);
      const map = Number(body.map);
      const seed = Number(body.seed || stageSeed(map));
      const score = Number(body.score);

      if (!validInteger(map) || map < 0 || map >= MAX_MAPS) {
        return json({ error: "Bad map" }, { status: 400 }, request, env);
      }

      if (!validInteger(score) || score < 1 || score > MAX_SCORE) {
        return json({ error: "Bad score" }, { status: 400 }, request, env);
      }

      if (!validInteger(seed) || seed !== stageSeed(map)) {
        return json({ error: "Bad seed" }, { status: 400 }, request, env);
      }

      await env.DB.prepare(
        `INSERT INTO scores (map, seed, initials, score)
         VALUES (?, ?, ?, ?)`
      ).bind(map, seed, initials, score).run();

      return json({ ok: true }, {}, request, env);
    }

    return json({ error: "Not found" }, { status: 404 }, request, env);
  },
};
