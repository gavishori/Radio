// Song-info server for the radio app.
// Most stream servers don't let a web page read the song title embedded in the stream (ICY metadata),
// and some stations' APIs block web pages too. This Worker reads them server-side and returns JSON
// that the page is allowed to read.
//
// GET /np?s=<id>|<source>&s=<id>|<source>…   →   { "<id>": { "title": "…", "artist": "…" } | null, … }
//   source "icy:<stream url>"        song title embedded in the stream, "Artist - Title"
//   source "icy-title-first:<url>"   same, but "Title - Artist"
//   source "rp:<channel>"            Radio Paradise now-playing API

// Only these stream hosts may be read, so the Worker can't be used as an open proxy.
const ALLOWED_HOSTS = [
  "gb25.streamgates.net", "cdna.streamgates.net", "radio.streamgates.net", "cdn.cybercdn.live",
  "liveradio.co.il", "listen.181fm.com", "bigrradio.cdnstream1.com", "stream0.wfmu.org",
  "loveradio.streamingmedia.it", "streaming.radiostreamlive.com", "stream.revma.ihrhls.com",
  "ice7.securenetsystems.net", "stream.wqxr.org", "classicalking.streamguys1.com",
  "us2.maindigitalstream.com", "pacificmedia.cdnstream1.com", "ais-sa8.cdnstream1.com",
  "knkx-live-a.edge.audiocdn.com", "r.bgp.rodeo",
  "kera.streamguys1.com", "ais-sa3.cdnstream1.com", "playerservices.streamtheworld.com",
  "www.wnyu-ice-cast-relay.com", "s5.radio.co", "listen.radioking.com", "pureplay.cdnstream1.com", "live.ecast.co.il",
];
const MAX_ITEMS = 40;   // stay under the free plan's 50 outgoing requests per call
const CACHE_SECONDS = 20;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/np") return new Response("Not found", { status: 404, headers: JSON_HEADERS });

    const items = url.searchParams.getAll("s").slice(0, MAX_ITEMS)
      .map(v => { const i = v.indexOf("|"); return i > 0 ? [v.slice(0, i), v.slice(i + 1)] : null; })
      .filter(Boolean);

    const results = await Promise.all(items.map(async ([id, source]) => {
      try { return [id, await cached(source, ctx)]; } catch { return [id, null]; }
    }));
    return new Response(JSON.stringify(Object.fromEntries(results)), { headers: JSON_HEADERS });
  },
};

// Each source is cached for a few seconds, so two devices (or a quick re-render) don't hit the station twice
async function cached(source, ctx) {
  const key = new Request("https://np-cache.internal/" + encodeURIComponent(source));
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const value = await lookup(source);
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(value), {
    headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` },
  })));
  return value;
}

async function lookup(source) {
  const i = source.indexOf(":");
  const kind = source.slice(0, i), arg = source.slice(i + 1);
  if (kind === "rp") {
    const r = await fetch(`https://api.radioparadise.com/api/now_playing?chan=${encodeURIComponent(arg)}`);
    const d = await r.json();
    return track(d.title, d.artist);
  }
  if (kind === "icy" || kind === "icy-title-first") {
    const target = new URL(arg);
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.includes(target.hostname)) return null;
    const title = await readStreamTitle(target.href);
    return title == null ? null : parseStreamTitle(title, kind === "icy-title-first");
  }
  return null;
}

// Read just past the first audio block to reach the metadata block, then hang up
export async function readStreamTitle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "Icy-MetaData": "1", "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
    const metaint = Number(r.headers.get("icy-metaint"));
    if (!metaint || !r.body) return null;
    const reader = r.body.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf); next.set(value, buf.length); buf = next;
      if (buf.length > metaint && buf.length >= metaint + 1 + buf[metaint] * 16) break;
    }
    const bytes = buf.slice(metaint + 1, metaint + 1 + buf[metaint] * 16);
    let meta;
    try { meta = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { meta = new TextDecoder("windows-1255").decode(bytes); }  // older Hebrew stations
    const m = meta.match(/StreamTitle='(.*?)';/s);
    return m ? m[1] : null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

export function parseStreamTitle(raw, titleFirst = false) {
  const s = raw.replace(/\0/g, "").trim();
  // iHeart: Artist - text="Title" song_spot="M" …  ("T" spots are ads and promos)
  let m = s.match(/^(.*?) - text="(.*?)" song_spot="(\w)"/);
  if (m) return m[3] === "T" ? null : track(m[2], m[1]);
  // iHeart, other layout: title="…",artist="…",…
  m = s.match(/title="(.*?)",artist="(.*?)"/);
  if (m) return track(m[1], m[2]);
  // WFMU: "Title" by Artist on Show on WFMU
  m = s.match(/^"(.*?)" by (.*?) on .* on WFMU/);
  if (m) return track(m[1], m[2]);
  // Everything else: "Artist - Title" (a title with no separator is a show or station name, not a song)
  const parts = s.split(" - ");
  if (parts.length < 2) return null;
  return titleFirst ? track(parts[0], parts[1]) : track(parts[1], parts[0]);
}

function track(title, artist) {
  const clean = v => String(v || "").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  title = clean(title); artist = clean(artist);
  const all = title + " " + artist;
  if (!title || /commercial|advertisement|after this break|membership drive|powered by|^cdn\b/i.test(all)) return null;
  if (/^[?\s]*$/.test(title)) return null;  // a station that sends Hebrew as "????"
  if (title.toLowerCase() === artist.toLowerCase() || /^advert|^track \d+$/i.test(title)) return null;  // placeholders, not songs
  return { title, artist };
}
