/* WhatImWatching — статичный сайт без сервера.
   Источники данных (по очереди, первый ответивший): Shikimori → AniList → Jikan (MyAnimeList).
   Все тайтлы идентифицируются по id MyAnimeList (у Shikimori он совпадает, у AniList есть поле idMal),
   поэтому список не ломается при смене источника.
   Список пользователя хранится в localStorage этого браузера. */
"use strict";

const DAY = 86400000;
const STORE_KEY = "anime-archive";      // ключ прежний, чтобы не потерять сохранённое
const PROVIDER_KEY = "wiw-provider";
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= сеть: таймаут, кэш, очередь ================= */
async function fetchT(url, init = {}, ms = 12000) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); }
  finally { clearTimeout(timer); }
}

const Cache = {
  get(k) {
    try { const o = JSON.parse(localStorage.getItem("jc:" + k)); if (o && Date.now() - o.t < o.ttl) return o.d; } catch (e) {}
    return undefined;
  },
  set(k, d, ttl) {
    const s = JSON.stringify({ t: Date.now(), ttl, d });
    try { localStorage.setItem("jc:" + k, s); }
    catch (e) { Cache.purge(); try { localStorage.setItem("jc:" + k, s); } catch (e2) {} }
  },
  purge() {
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("jc:")) ks.push(k); }
    ks.forEach(k => localStorage.removeItem(k));
  }
};

let P = null;                     // активный источник
let chain = Promise.resolve(), stamps = [];
/* call: кэш + очередь с лимитом источника + повторы при 429/5xx/сбоях сети */
function call(key, ttl, fetcher, map) {
  const ck = P.cacheKey() + ":" + key;
  const hit = Cache.get(ck);
  if (hit !== undefined) return Promise.resolve(hit);
  const run = async () => {
    const again = Cache.get(ck);
    if (again !== undefined) return again;
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now();
      stamps = stamps.filter(t => now - t < 60000);
      if (stamps.length >= P.perMin) await sleep(60000 - (now - stamps[0]) + 100);
      const gap = Date.now() - (stamps[stamps.length - 1] || 0);
      if (gap < P.gap) await sleep(P.gap - gap);
      stamps.push(Date.now());
      let res;
      try { res = await fetcher(); }
      catch (e) { if (attempt < 1) { await sleep(1500); continue; } throw new Error("network"); }
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 404) { Cache.set(ck, null, ttl); return null; }
      if (!res.ok) throw new Error("http " + res.status);
      const data = map(await res.json());
      Cache.set(ck, data, ttl);
      return data;
    }
    throw new Error("busy");
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ================= общие утилиты для данных ================= */
function cleanText(s) {
  if (!s) return "";
  let t = String(s);
  for (let i = 0; i < 4; i++) t = t.replace(/\[(\w+)(?:=[^\]]*)?\]([\s\S]*?)\[\/\1\]/g, "$2"); // BBCode Shikimori
  t = t.replace(/\[[^\]]*\]/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  t = t.replace(/\s*\(Source:[^)]*\)\s*$/i, "").replace(/\s*\[Written by MAL Rewrite\]\s*/i, "");
  const el = document.createElement("textarea"); el.innerHTML = t; t = el.value; // HTML-сущности
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, 900);
}
const TYPE_RU = { TV: "ТВ", Movie: "Фильм", OVA: "OVA", ONA: "ONA", Special: "Спешл", Music: "Клип", "TV Special": "ТВ-спешл" };
const typeRu = t => TYPE_RU[t] || t || "";
const nm = a => a.ru || a.en || a.t;                         // главное название
const sub = a => [a.ru ? (a.en || a.t) : a.en ? a.t : ""].filter(Boolean)[0] || "";
const ok = a => a && !a.adult;

/* ================= источник 1: Shikimori ================= */
const SHIKI_KIND = { tv: "TV", tv_13: "TV", tv_24: "TV", tv_48: "TV", movie: "Movie", ova: "OVA", ona: "ONA", special: "Special", tv_special: "TV Special", music: "Music", pv: "PV", cm: "CM" };
const shikimori = {
  name: "shikimori", label: "Shikimori", perMin: 80, gap: 250,
  origins: ["https://shikimori.io", "https://shikimori.one", "https://shikimori.me"],
  origin: null,
  cacheKey() { return "shiki@" + this.origin; },
  searchHint: "Название по-русски, по-английски или ромадзи",
  async probe(log) {
    const saved = localStorage.getItem(PROVIDER_KEY + "-origin");
    const list = saved ? [saved, ...this.origins.filter(o => o !== saved)] : this.origins;
    for (const o of list) {
      try {
        const r = await fetchT(o + "/api/animes?order=popularity&limit=1&censored=true", {}, 8000);
        if (r.ok && Array.isArray(await r.json())) { this.origin = o; localStorage.setItem(PROVIDER_KEY + "-origin", o); return; }
        log(`${o}: ответ ${r.status}`);
      } catch (e) { log(`${o}: ${e.name === "AbortError" ? "нет ответа за 8 сек" : "соединение не установлено"}`); }
    }
    throw new Error("shikimori");
  },
  img(p) { return !p || /missing/.test(p) ? "" : p.startsWith("http") ? p : this.origin + p; },
  short(a, rank) {
    return {
      id: a.id, t: a.name || "", ru: a.russian || "", en: "",
      img: this.img(a.image?.preview || a.image?.original), imgL: this.img(a.image?.original || a.image?.preview),
      y: (a.aired_on || a.released_on || "").slice(0, 4), type: SHIKI_KIND[a.kind] || a.kind || "",
      ep: a.episodes || a.episodes_aired || "", sc: Number(a.score) || "", pop: rank || "", g: [], syn: "", adult: false, full: false
    };
  },
  full(a) {
    return {
      ...this.short(a), en: (a.english || [])[0] || "",
      g: (a.genres || []).map(g => g.russian || g.name).slice(0, 5),
      syn: cleanText(a.description), full: true,
      adult: a.rating === "rx" || (a.genres || []).some(g => g.name === "Hentai" || g.name === "Erotica")
    };
  },
  list(path, key, ttl, page = 1) {
    return call(key, ttl, () => fetchT(this.origin + path), j => {
      const arr = Array.isArray(j) ? j : [];
      return { items: arr.map((a, i) => this.short(a, (page - 1) * 50 + i + 1)), next: arr.length === 50 };
    });
  },
  topPage(p) { return this.list(`/api/animes?order=popularity&limit=50&page=${p}&censored=true`, "pop" + p, DAY * 3, p); },
  topRated(p) { return this.list(`/api/animes?order=ranked&limit=50&page=${p}&censored=true`, "rank" + p, DAY * 3, p).then(r => r.items); },
  search(q) { return this.list(`/api/animes?search=${encodeURIComponent(q)}&limit=10&censored=true`, "s:" + q.toLowerCase(), DAY).then(r => r.items); },
  details(id) { return call("d" + id, DAY * 7, () => fetchT(`${this.origin}/api/animes/${id}`), a => a && a.id ? this.full(a) : null); },
  similar(id) {
    return call("sim" + id, DAY * 7, () => fetchT(`${this.origin}/api/animes/${id}/similar`), j =>
      (Array.isArray(j) ? j : []).slice(0, 25).map((a, i) => ({ ...this.short(a), v: Math.max(1, 20 - i) })));
  }
};

/* ================= источник 2: AniList ================= */
const AL_FIELDS = "id idMal isAdult title{romaji english} coverImage{large extraLarge} seasonYear startDate{year} format episodes averageScore popularity genres description(asHtml:false)";
const AL_FMT = { TV: "TV", TV_SHORT: "TV", MOVIE: "Movie", OVA: "OVA", ONA: "ONA", SPECIAL: "Special", MUSIC: "Music" };
function gql(query, variables, ms) {
  return () => fetchT("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables })
  }, ms);
}
const anilist = {
  name: "anilist", label: "AniList", perMin: 28, gap: 700,
  cacheKey() { return "al"; },
  searchHint: "Название по-английски или ромадзи",
  async probe(log) {
    try {
      const r = await gql("query{Media(idMal:1,type:ANIME){id}}", {}, 8000)();
      if (r.ok) return;
      log("AniList: ответ " + r.status);
    } catch (e) { log("AniList: " + (e.name === "AbortError" ? "нет ответа за 8 сек" : "соединение не установлено")); }
    throw new Error("anilist");
  },
  trim(m, rank) {
    if (!m || !m.idMal) return null;
    const en = m.title?.english && m.title.english !== m.title.romaji ? m.title.english : "";
    return {
      id: m.idMal, t: m.title?.romaji || "", ru: "", en,
      img: m.coverImage?.large || "", imgL: m.coverImage?.extraLarge || m.coverImage?.large || "",
      y: m.seasonYear || m.startDate?.year || "", type: AL_FMT[m.format] || m.format || "",
      ep: m.episodes || "", sc: m.averageScore ? (m.averageScore / 10).toFixed(1) : "", pop: rank || "",
      g: (m.genres || []).slice(0, 5), syn: cleanText(m.description), adult: !!m.isAdult, full: true
    };
  },
  page(sort, p, key, ttl) {
    return call(key, ttl, gql(`query($p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage} media(type:ANIME,sort:${sort},isAdult:false){${AL_FIELDS}}}}`, { p }),
      j => ({ items: (j.data?.Page?.media || []).map((m, i) => this.trim(m, (p - 1) * 50 + i + 1)).filter(Boolean), next: !!j.data?.Page?.pageInfo?.hasNextPage }));
  },
  topPage(p) { return this.page("POPULARITY_DESC", p, "pop" + p, DAY * 3); },
  topRated(p) { return this.page("SCORE_DESC", p, "rank" + p, DAY * 3).then(r => r.items); },
  search(q) {
    return call("s:" + q.toLowerCase(), DAY, gql(`query($q:String){Page(perPage:10){media(search:$q,type:ANIME,isAdult:false){${AL_FIELDS}}}}`, { q }),
      j => (j.data?.Page?.media || []).map(m => this.trim(m)).filter(Boolean));
  },
  details(id) {
    return call("d" + id, DAY * 7, gql(`query($id:Int){Media(idMal:$id,type:ANIME){${AL_FIELDS}}}`, { id }), j => this.trim(j.data?.Media));
  },
  similar(id) {
    return call("sim" + id, DAY * 7, gql(`query($id:Int){Media(idMal:$id,type:ANIME){recommendations(sort:RATING_DESC,perPage:25){nodes{rating mediaRecommendation{${AL_FIELDS}}}}}}`, { id }),
      j => (j.data?.Media?.recommendations?.nodes || []).map(n => {
        const a = this.trim(n.mediaRecommendation); return a && !a.adult ? { ...a, v: Math.max(1, n.rating || 1) } : null;
      }).filter(Boolean));
  }
};

/* ================= источник 3: Jikan (MyAnimeList) ================= */
const JIKAN = "https://api.jikan.moe/v4";
const jikan = {
  name: "jikan", label: "MyAnimeList (Jikan)", perMin: 55, gap: 400,
  cacheKey() { return "jk"; },
  searchHint: "Название по-английски или ромадзи",
  async probe(log) {
    try { const r = await fetchT(JIKAN + "/anime/1", {}, 8000); if (r.ok) return; log("Jikan: ответ " + r.status); }
    catch (e) { log("Jikan: " + (e.name === "AbortError" ? "нет ответа за 8 сек" : "соединение не установлено")); }
    throw new Error("jikan");
  },
  trim(a) {
    const img = a.images || {};
    return {
      id: a.mal_id, t: a.title, ru: "", en: a.title_english && a.title_english !== a.title ? a.title_english : "",
      img: img.webp?.image_url || img.jpg?.image_url || "", imgL: img.webp?.large_image_url || img.jpg?.large_image_url || img.jpg?.image_url || "",
      y: a.year || a.aired?.prop?.from?.year || "", type: a.type || "", ep: a.episodes || "", sc: a.score || "", pop: a.popularity || "",
      g: (a.genres || []).concat(a.themes || []).map(g => g.name).slice(0, 5), syn: cleanText(a.synopsis), full: true,
      adult: /^Rx/.test(a.rating || "") || (a.genres || []).some(g => g.name === "Hentai" || g.name === "Erotica")
    };
  },
  topPage(p) {
    return call("pop" + p, DAY * 3, () => fetchT(`${JIKAN}/top/anime?filter=bypopularity&sfw=true&page=${p}&limit=25`),
      j => ({ items: (j.data || []).map(a => this.trim(a)), next: !!j.pagination?.has_next_page }));
  },
  topRated(p) { return call("rank" + p, DAY * 3, () => fetchT(`${JIKAN}/top/anime?sfw=true&page=${p}&limit=25`), j => (j.data || []).map(a => this.trim(a))); },
  search(q) { return call("s:" + q.toLowerCase(), DAY, () => fetchT(`${JIKAN}/anime?q=${encodeURIComponent(q)}&sfw=true&limit=10`), j => (j.data || []).map(a => this.trim(a))); },
  details(id) { return call("d" + id, DAY * 7, () => fetchT(`${JIKAN}/anime/${id}`), j => j && j.data ? this.trim(j.data) : null); },
  similar(id) {
    return call("sim" + id, DAY * 7, () => fetchT(`${JIKAN}/anime/${id}/recommendations`), j => (j.data || []).slice(0, 25).map(r => ({
      id: r.entry.mal_id, t: r.entry.title, ru: "", en: "", img: r.entry.images?.webp?.image_url || r.entry.images?.jpg?.image_url || "", v: r.votes || 1
    })));
  }
};

const PROVIDERS = { shikimori, anilist, jikan };
let providerPromise = null;
function connect() {
  if (!providerPromise) providerPromise = (async () => {
    const saved = localStorage.getItem(PROVIDER_KEY);
    const order = ["shikimori", "anilist", "jikan"];
    if (saved && order.includes(saved)) order.unshift(...order.splice(order.indexOf(saved), 1));
    const problems = [];
    for (const name of order) {
      setSource(`подключаюсь к ${PROVIDERS[name].label}…`);
      try {
        await PROVIDERS[name].probe(m => problems.push(m));
        P = PROVIDERS[name];
        localStorage.setItem(PROVIDER_KEY, name);
        setSource("данные: " + P.label + (P === shikimori ? " (" + P.origin.replace("https://", "") + ")" : ""));
        $("sq").placeholder = P.searchHint;
        return P;
      } catch (e) {}
    }
    const err = new Error("no-provider"); err.problems = problems; throw err;
  })();
  providerPromise.catch(() => { providerPromise = null; });
  return providerPromise;
}
function setSource(t) { $("srcLine").textContent = t; }
function connectionError(box, e, retry) {
  box.replaceChildren(
    h("span", { class: "err" }, "Не удалось подключиться ни к одной базе аниме. "),
    h("button", { class: "linkbtn", type: "button", onclick: retry }, "Попробовать снова"),
    e && e.problems ? h("details", { class: "diag" }, h("summary", {}, "Что именно не сработало"), h("ul", {}, e.problems.map(p => h("li", {}, p)))) : null);
}

/* ================= хранилище пользователя ================= */
let marks = {};
function loadStore() { try { marks = JSON.parse(localStorage.getItem(STORE_KEY) || "{}").marks || {}; } catch (e) { marks = {}; } }
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, marks })); }
  catch (e) { Cache.purge(); try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, marks })); } catch (e2) { toast("Не удалось сохранить: в браузере закончилось место"); } }
}
let recsDirty = true;
function setMark(id, val, opts = {}) {
  if (val) marks[id] = val; else delete marks[id];
  saveStore();
  if (!opts.keepRecs) recsDirty = true;
  renderStats(); renderList();
  if (!opts.noQuiz) showCard();
}
function markFrom(a, extra) {
  return { t: a.t || "", ru: a.ru || "", en: a.en || "", img: a.img || "", y: a.y || "", type: a.type || "", at: Date.now(), ...extra };
}

/* ================= мелочи интерфейса ================= */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
let toastTimer;
function toast(text, undoFn) {
  $("toastText").textContent = text;
  $("toastUndo").hidden = !undoFn;
  $("toastUndo").onclick = () => { undoFn && undoFn(); $("toast").hidden = true; };
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").hidden = true, 4500);
}
function scoreRow(onPick, label = "Оценка:") {
  const row = h("div", { class: "miniscores" }, label);
  for (let n = 1; n <= 10; n++) row.append(h("button", { type: "button", onclick: () => onPick(n) }, String(n)));
  row.append(h("button", { type: "button", class: "linkbtn", style: "width:auto;border:0", onclick: () => onPick(null) }, "без оценки"));
  return row;
}
function chipsFor(a) {
  return [typeRu(a.type), a.y, a.ep ? a.ep + " эп." : "", a.sc ? "★ " + a.sc : ""].filter(Boolean).map(x => h("span", { class: "chip" }, String(x)));
}
const pageUrl = a => P === shikimori ? `${P.origin}/animes/${a.id}` : `https://myanimelist.net/anime/${a.id}`;
const pageLabel = () => P === shikimori ? "страница на Shikimori ↗" : "страница на MyAnimeList ↗";

/* ================= статистика ================= */
function renderStats() {
  const vals = Object.values(marks);
  const seen = vals.filter(m => m.s === "seen"), scored = seen.filter(m => m.score);
  $("stSeen").textContent = seen.length;
  $("stAvg").textContent = scored.length ? (scored.reduce((s, m) => s + m.score, 0) / scored.length).toFixed(1) : "—";
  $("stWant").textContent = vals.filter(m => m.s === "want").length;
  $("pText").textContent = "Отмечено: " + vals.length;
}

/* ================= ВСПОМНИТЬ ================= */
const catalog = [], inCatalog = new Set();
let nextPage = 1, hasNext = true, loadingPage = null;
function loadPage() {
  if (loadingPage) return loadingPage;
  if (!hasNext) return Promise.resolve();
  const page = nextPage;
  loadingPage = P.topPage(page).then(r => {
    for (const it of (r?.items || []).filter(ok)) if (!inCatalog.has(it.id)) { inCatalog.add(it.id); catalog.push(it); }
    hasNext = !!r?.next; nextPage = page + 1;
  }).finally(() => { loadingPage = null; });
  return loadingPage;
}
const quizQueue = () => catalog.filter(c => !marks[c.id]);
let current = null, rating = false, undoStack = [], filling = false;

async function fillQueue() {
  if (filling) return;
  filling = true;
  try {
    if (!P) await connect();
    while (hasNext && quizQueue().length < 5) {
      if (!catalog.length) $("quizMsg").textContent = "Загружаю каталог…";
      await loadPage();
      if (!current) showCard();
    }
    $("quizMsg").textContent = "";
  } catch (e) {
    if (e.message === "no-provider") connectionError($("quizMsg"), e, () => fillQueue());
    else $("quizMsg").replaceChildren(h("span", { class: "err" }, "Каталог не загрузился. "), h("button", { class: "linkbtn", type: "button", onclick: () => fillQueue() }, "Попробовать снова"));
    if (!current) { $("cRank").textContent = "нет связи"; }
  } finally { filling = false; }
  if (!current) showCard();
}

function showCard() {
  if (rating) return;
  const q = quizQueue();
  if (q.length < 5 && P) fillQueue();
  const next = q[0] || null;
  if (next && current && next.id === current.id && $("cTitle").textContent === nm(next)) return;
  current = next;
  $("actions").hidden = !current;
  if (!current) {
    if (P && !hasNext) { $("cRank").textContent = "каталог пройден"; $("cTitle").textContent = "Ты прошёл весь каталог"; }
    $("cOrig").textContent = ""; $("cChips").textContent = ""; $("cSyn").textContent = "";
    $("cImg").removeAttribute("src"); $("cLink").hidden = true;
    return;
  }
  const a = current;
  $("cRank").textContent = a.pop ? `#${a.pop} по популярности` : "";
  $("cKind").textContent = typeRu(a.type);
  $("cTitle").textContent = nm(a);
  $("cOrig").textContent = sub(a);
  fillCardDetails(a);
  $("cImg").src = a.imgL || a.img; $("cImg").alt = "Постер: " + nm(a);
  $("cLink").hidden = false; $("cLink").href = pageUrl(a); $("cLink").textContent = pageLabel();
  $("stamp").className = "stampmark";
  if (q[1]) { const pre = new Image(); pre.src = q[1].imgL || q[1].img; }
  if (!a.full) {
    P.details(a.id).then(d => {
      if (!d) return;
      Object.assign(a, { en: d.en, g: d.g, syn: d.syn, adult: d.adult, full: true, ep: a.ep || d.ep });
      if (current && current.id === a.id) {
        if (a.adult) { catalog.splice(catalog.indexOf(a), 1); current = null; showCard(); return; }
        $("cOrig").textContent = sub(a); fillCardDetails(a);
      }
    }).catch(() => {});
  }
}
function fillCardDetails(a) {
  $("cChips").replaceChildren(...chipsFor(a), ...a.g.slice(0, 3).map(g => h("span", { class: "chip" }, g)));
  $("cSyn").textContent = a.syn || "";
}
function stamp(text, okColor) {
  const s = $("stamp"); s.textContent = text; s.className = "stampmark"; void s.offsetWidth;
  s.className = "stampmark on" + (okColor ? " ok" : "");
}
function markSeen() { if (!current || rating) return; rating = true; stamp("СМОТРЕЛ", true); $("actions").hidden = true; $("rate").hidden = false; }
function finishSeen(score) {
  if (!current || !rating) return;
  const a = current; rating = false; $("rate").hidden = true;
  undoStack.push(a.id); setMark(a.id, markFrom(a, { s: "seen", score: score ?? null }));
}
function markOther(s) {
  if (!current || rating) return;
  const a = current; stamp(s === "no" ? "НЕТ" : "?", false); undoStack.push(a.id);
  rating = true;
  setTimeout(() => { rating = false; setMark(a.id, markFrom(a, { s })); }, 180);
}
function undo() {
  if (rating && !$("rate").hidden) { rating = false; $("rate").hidden = true; $("actions").hidden = false; $("stamp").className = "stampmark"; return; }
  const id = undoStack.pop();
  if (id) { setMark(id, null); current = null; showCard(); }
}

/* ================= МОЙ СПИСОК ================= */
let filterS = "seen";
function renderList() {
  const all = Object.entries(marks).map(([id, m]) => ({ id: Number(id), ...m }));
  const counts = {};
  all.forEach(e => counts[e.s] = (counts[e.s] || 0) + 1);
  for (const b of $("seg").children) b.querySelector("span").textContent = counts[b.dataset.s] || "";
  const q = $("q").value.trim().toLowerCase();
  const rows = all.filter(e => e.s === filterS && (!q || [e.ru, e.en, e.t].join(" ").toLowerCase().includes(q)));
  const sort = $("sort").value;
  rows.sort((a, b) => sort === "score" ? ((b.score ?? -1) - (a.score ?? -1)) || nm(a).localeCompare(nm(b), "ru")
    : sort === "year" ? (Number(b.y) || 0) - (Number(a.y) || 0)
    : sort === "recent" ? (b.at || 0) - (a.at || 0)
    : nm(a).localeCompare(nm(b), "ru"));
  const ul = $("ul");
  if (!rows.length) {
    ul.replaceChildren(h("li", { class: "empty" }, filterS === "seen"
      ? "Пока пусто. Отмечай тайтлы во вкладке «Вспомнить» или найди их через поиск выше." : "Здесь пусто."));
    return;
  }
  const LABELS = [["seen", "смотрел"], ["want", "хочу"], ["maybe", "не помню"], ["no", "не смотрел"]];
  ul.replaceChildren(...rows.map(e => {
    const sel = h("select", { "aria-label": "Оценка " + nm(e) },
      h("option", { value: "" }, "—"), ...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => h("option", { value: n }, String(n))));
    sel.value = e.score ?? "";
    if (e.s !== "seen") sel.style.visibility = "hidden";
    sel.onchange = () => setMark(e.id, { ...marks[e.id], score: sel.value ? Number(sel.value) : null }, { noQuiz: true });
    const mv = h("div", { class: "mv" }, LABELS.filter(([s]) => s !== e.s).map(([s, l]) =>
      h("button", { type: "button", onclick: () => setMark(e.id, { ...marks[e.id], s, at: Date.now() }, { noQuiz: true }) }, "→ " + l)));
    return h("li", {},
      h("img", { class: "thumb", src: e.img || "", alt: "", loading: "lazy" }),
      h("div", {},
        h("a", { class: "t", href: P ? pageUrl(e) : "https://myanimelist.net/anime/" + e.id, target: "_blank", rel: "noopener", style: "text-decoration:none" }, nm(e)),
        h("div", { class: "o" }, [sub(e), typeRu(e.type), e.y].filter(Boolean).join(" · ")),
        mv),
      sel,
      h("button", { class: "x", type: "button", title: "Убрать из списка", "aria-label": "Убрать " + nm(e),
        onclick: () => { const prev = marks[e.id]; setMark(e.id, null, { noQuiz: true }); toast("Убрано: " + nm(e), () => setMark(e.id, prev, { noQuiz: true })); } }, "✕"));
  }));
}

/* поиск для ручного добавления */
let searchTimer, searchSeq = 0;
$("sq").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("sq").value.trim();
  if (q.length < 2) { $("sres").replaceChildren(); return; }
  searchTimer = setTimeout(() => runSearch(q), 500);
});
const STATUS_RU = { seen: "смотрел", want: "хочу", maybe: "не помню", no: "не смотрел", skip: "не интересно" };
async function runSearch(q) {
  const seq = ++searchSeq;
  $("sres").replaceChildren(h("li", { class: "note", style: "display:block" }, "Ищу…"));
  try {
    if (!P) await connect();
    const list = ((await P.search(q)) || []).filter(ok);
    if (seq !== searchSeq) return;
    if (!list.length) { $("sres").replaceChildren(h("li", { class: "note", style: "display:block" }, "Ничего не нашлось. Попробуй другое написание.")); return; }
    $("sres").replaceChildren(...list.map(a => {
      const btns = h("div", { class: "rowbtns" });
      const fill = () => {
        const m = marks[a.id];
        if (m) { btns.replaceChildren(h("span", { class: "note" }, "уже в списке: " + STATUS_RU[m.s])); return; }
        btns.replaceChildren(
          h("button", { class: "btn yes small", type: "button", onclick: () => btns.replaceChildren(scoreRow(s => { setMark(a.id, markFrom(a, { s: "seen", score: s })); toast("Добавлено: " + nm(a)); fill(); })) }, "Смотрел"),
          h("button", { class: "btn small", type: "button", onclick: () => { setMark(a.id, markFrom(a, { s: "want" })); toast("В планах: " + nm(a)); fill(); } }, "Хочу"));
      };
      fill();
      return h("li", {},
        h("img", { class: "thumb", src: a.img, alt: "", loading: "lazy" }),
        h("div", {}, h("div", { class: "t" }, nm(a)), h("div", { class: "o" }, [sub(a), typeRu(a.type), a.y].filter(Boolean).join(" · "))),
        btns);
    }));
  } catch (e) {
    if (seq !== searchSeq) return;
    if (e.message === "no-provider") { const li = h("li", { style: "display:block" }); connectionError(li, e, () => runSearch(q)); $("sres").replaceChildren(li); }
    else $("sres").replaceChildren(h("li", { class: "err", style: "display:block" }, "Поиск не ответил. Попробуй ещё раз через минуту."));
  }
}

/* экспорт / импорт */
$("bExport").onclick = () => {
  const blob = new Blob([JSON.stringify({ v: 1, exported: new Date().toISOString(), marks }, null, 1)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "whatimwatching-" + new Date().toISOString().slice(0, 10) + ".json" });
  document.body.append(a); a.click(); a.remove();
};
$("fImport").onchange = async () => {
  const f = $("fImport").files[0]; if (!f) return;
  $("tImport").value = await f.text(); $("fImport").value = "";
  importText($("tImport").value);
};
$("bImport").onclick = () => importText($("tImport").value);
async function importText(text) {
  const msg = $("ioMsg");
  let data;
  try { data = JSON.parse(text); } catch (e) { msg.textContent = "Это не похоже на JSON. Проверь, что скопировано целиком."; return; }
  if (data && data.marks && typeof data.marks === "object") {
    let n = 0;
    for (const [id, m] of Object.entries(data.marks)) if (m && m.s && (m.t || m.ru)) { marks[id] = m; n++; }
    saveStore(); recsDirty = true; renderStats(); renderList(); current = null; showCard();
    msg.textContent = `Готово: перенесено ${n} записей.`; return;
  }
  const arr = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(arr)) { msg.textContent = "Не понял формат файла."; return; }
  $("bImport").disabled = true;
  try { if (!P) await connect(); }
  catch (e) { connectionError(msg, e, () => importText(text)); $("bImport").disabled = false; return; }
  let done = 0, added = 0; const missed = [];
  const clean = s => String(s || "").replace(/\(.*?\)/g, "").trim();
  for (const it of arr) {
    done++;
    msg.textContent = `Ищу тайтлы: ${done} из ${arr.length}…`;
    const queries = [clean(it.orig), P === shikimori ? clean(it.title) : ""].filter(Boolean);
    let a = null;
    for (const q of queries) {
      try {
        const res = ((await P.search(q)) || []).filter(Boolean);
        a = res.find(x => it.year && String(x.y) === String(it.year)) || res[0] || null;
        if (a) break;
      } catch (e) {}
    }
    if (!a) { missed.push(it.title || it.orig); continue; }
    if (!marks[a.id]) { marks[a.id] = markFrom(a, { s: it.status || "seen", score: it.score ?? null, at: it.at || Date.now() }); added++; saveStore(); }
  }
  $("bImport").disabled = false;
  recsDirty = true; renderStats(); renderList(); current = null; showCard();
  msg.textContent = `Готово: добавлено ${added}.` + (missed.length ? ` Не нашлись (добавь вручную через поиск): ${missed.join(", ")}.` : "");
}

/* ================= ЧТО ПОСМОТРЕТЬ ================= */
let recs = [], recPos = 0, recBusy = false;
function recHint() {
  const seen = Object.values(marks).filter(m => m.s === "seen");
  const liked = seen.filter(m => m.score >= 7).length;
  $("recHint").textContent = !seen.length
    ? "Ты ещё ничего не отметил, поэтому покажу самые высоко оценённые тайтлы. Чтобы подборка стала личной, отметь просмотренное во вкладке «Вспомнить»."
    : liked < 5
      ? `Подборка строится по тому, что ты оценил на 7 и выше (сейчас таких ${liked}). После 10–15 оценок советы станут точнее.`
      : `Подборка строится по ${liked} тайтлам, которые ты оценил на 7 и выше. Просмотренное и отложенное не предлагается.`;
}

/* Для каждого любимого тайтла берём список «похожих», складываем с весом оценки;
   низкие оценки вычитают; совпадения из нескольких любимых тайтлов получают бонус. */
async function computeRecs(progress) {
  const seen = Object.entries(marks).filter(([, m]) => m.s === "seen");
  const liked = seen.filter(([, m]) => m.score == null || m.score >= 7)
    .sort((a, b) => (b[1].score ?? 6.5) - (a[1].score ?? 6.5) || (b[1].at || 0) - (a[1].at || 0)).slice(0, 18);
  const disliked = seen.filter(([, m]) => m.score != null && m.score <= 4).slice(0, 6);
  const blocked = id => marks[id] && marks[id].s !== "no";

  if (!liked.length) {
    const out = [];
    for (let p = 1; p <= 2; p++) {
      progress(`Загружаю лучшие тайтлы… (${p}/2)`);
      out.push(...(((await P.topRated(p)) || []).filter(ok)));
    }
    return out.filter(a => !blocked(a.id)).map(a => ({ ...a, from: [] }));
  }

  const cand = new Map();
  const sources = liked.concat(disliked);
  let i = 0;
  for (const [id, m] of sources) {
    progress(`Изучаю твои оценки: ${++i} из ${sources.length}`);
    let list;
    try { list = await P.similar(Number(id)); } catch (e) { continue; }
    if (!list) continue;
    const w = m.score == null ? 0.6 : m.score >= 7 ? (m.score - 6) / 2 : -1;
    for (const r of list) {
      const c = cand.get(r.id) || { ...r, score: 0, hits: 0, from: [] };
      const add = w * Math.log2(1 + r.v);
      c.score += add;
      if (add > 0) { c.hits++; c.from.push({ t: nm(m), add }); }
      cand.set(r.id, c);
    }
  }
  return [...cand.values()]
    .filter(c => c.score > 0 && !blocked(c.id))
    .map(c => ({ ...c, score: c.score * (1 + 0.25 * (c.hits - 1)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .map(c => ({ ...c, from: c.from.sort((a, b) => b.add - a.add).slice(0, 3).map(f => f.t) }));
}

async function startRecs() {
  if (recBusy) return;
  if (!recsDirty && recs.length && recPos < recs.length) { showRec(); return; }
  recBusy = true; $("bRec").disabled = true;
  try {
    if (!P) { $("recStatus").textContent = "Подключаюсь…"; await connect(); }
    recs = await computeRecs(t => $("recStatus").textContent = t);
    recsDirty = false; recPos = 0;
    $("recStatus").textContent = recs.length ? "" : "Не нашлось новых вариантов. Оцени ещё несколько тайтлов.";
    if (recs.length) await showRec();
  } catch (e) {
    if (e.message === "no-provider") connectionError($("recStatus"), e, () => startRecs());
    else $("recStatus").replaceChildren(h("span", { class: "err" }, "База аниме сейчас не отвечает. Попробуй через минуту."));
  } finally { recBusy = false; $("bRec").disabled = false; }
}

async function showRec() {
  while (recPos < recs.length && marks[recs[recPos].id] && marks[recs[recPos].id].s !== "no") recPos++;
  if (recPos >= recs.length) {
    $("recBox").replaceChildren(); $("recMore").hidden = true;
    $("recStatus").textContent = "Варианты закончились. Нажми «Подобрать аниме», чтобы пересчитать по свежим оценкам.";
    recsDirty = true; $("bRec").textContent = "Подобрать аниме"; return;
  }
  const r = recs[recPos];
  $("bRec").textContent = "Пересчитать подборку";
  let a = r.full ? r : null;
  if (!a) {
    $("recStatus").textContent = "Загружаю описание…";
    try { a = await P.details(r.id); } catch (e) { a = null; }
    $("recStatus").textContent = "";
  }
  if (!a) a = { ...r, g: r.g || [], syn: "" };
  if (a.adult) { recPos++; return showRec(); }

  const title = nm(a);
  const btns = h("div", { class: "recbtns" });
  const advance = () => { recPos++; showRec(); };
  btns.append(
    h("button", { class: "btn yes small", type: "button", onclick: () => { setMark(a.id, markFrom(a, { s: "want" }), { keepRecs: true }); toast("В планах: " + title, () => setMark(a.id, null, { keepRecs: true })); advance(); } }, "Хочу посмотреть"),
    h("button", { class: "btn small", type: "button", onclick: () => btns.replaceChildren(scoreRow(s => { setMark(a.id, markFrom(a, { s: "seen", score: s }), { keepRecs: true }); recsDirty = true; toast("Добавлено в просмотренное: " + title); advance(); }, "Твоя оценка:")) }, "Уже смотрел"),
    h("button", { class: "btn small", type: "button", onclick: () => { setMark(a.id, markFrom(a, { s: "skip" }), { keepRecs: true }); advance(); } }, "Не интересно"),
    h("button", { class: "btn small", type: "button", onclick: advance }, "Следующее →"));

  const why = r.from.length
    ? h("p", { class: "why" }, h("b", {}, "Потому что тебе понравилось: "), r.from.join(", "))
    : h("p", { class: "why" }, h("b", {}, "Почему: "), "один из самых высоко оценённых тайтлов.");

  $("recBox").replaceChildren(h("article", { class: "rec" },
    h("div", { class: "poster" }, h("img", { src: a.imgL || a.img || r.img, alt: "Постер: " + title })),
    h("div", { class: "info" },
      h("h2", {}, title),
      sub(a) ? h("div", { class: "orig" }, sub(a)) : null,
      h("div", { class: "chips" }, chipsFor(a), (a.g || []).slice(0, 4).map(g => h("span", { class: "chip" }, g))),
      why,
      a.syn ? h("p", { class: "syn" }, a.syn) : null,
      h("a", { class: "muted-link", href: pageUrl(a), target: "_blank", rel: "noopener" }, P === shikimori ? "Подробнее на Shikimori ↗" : "Подробнее на MyAnimeList ↗"),
      btns)));

  const more = recs.slice(recPos + 1).filter(x => !marks[x.id] || marks[x.id].s === "no").slice(0, 10);
  $("recMore").hidden = !more.length;
  $("recStrip").replaceChildren(...more.map(x => h("li", {}, h("button", { type: "button", onclick: () => {
    recs.splice(recs.indexOf(x), 1); recs.splice(recPos, 0, x); showRec(); window.scrollTo({ top: $("recs").offsetTop - 20, behavior: "smooth" });
  } }, h("img", { src: x.img, alt: "", loading: "lazy" }), h("span", {}, nm(x))))));
}
$("bRec").onclick = () => { if ($("bRec").textContent.startsWith("Пересчитать")) recsDirty = true; startRecs(); };

/* ================= вкладки, клавиши, запуск ================= */
function tab(name) {
  for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-selected", b.dataset.tab === name);
  for (const s of ["quiz", "list", "recs"]) $(s).hidden = s !== name;
  if (name === "recs") recHint();
  if (name === "list") renderList();
}
document.querySelector("nav").onclick = e => { const b = e.target.closest("button"); if (b) tab(b.dataset.tab); };
$("seg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  filterS = b.dataset.s;
  for (const x of $("seg").children) x.setAttribute("aria-pressed", x === b);
  renderList();
};
$("q").oninput = renderList; $("sort").onchange = renderList;

const sc = $("scores");
for (let n = 1; n <= 10; n++) sc.append(h("button", { type: "button", onclick: () => finishSeen(n) }, String(n)));
$("bYes").onclick = markSeen; $("bNo").onclick = () => markOther("no"); $("bMaybe").onclick = () => markOther("maybe");
$("bNoScore").onclick = () => finishSeen(null); $("bUndo").onclick = undo;

document.addEventListener("keydown", e => {
  if ($("quiz").hidden || e.target.matches("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (rating && !$("rate").hidden) {
    if (/^[0-9]$/.test(k)) { finishSeen(k === "0" ? 10 : Number(k)); e.preventDefault(); }
    else if (k === "enter") { finishSeen(null); e.preventDefault(); }
    else if (k === "z" || k === "я" || k === "escape") undo();
    return;
  }
  if (k === "arrowright" || k === "y" || k === "н") { markSeen(); e.preventDefault(); }
  else if (k === "arrowleft" || k === "n" || k === "т") { markOther("no"); e.preventDefault(); }
  else if (k === "arrowdown" || k === "m" || k === "ь") { markOther("maybe"); e.preventDefault(); }
  else if (k === "z" || k === "я") undo();
});

loadStore();
renderStats();
renderList();
showCard();
fillQueue();
