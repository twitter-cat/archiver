import {parsetweetquery, parseuserquery, matchtweet, matchuser} from "./search.js";

// this file is REALLY long again, but idk where to split it
"use strict";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

window.onmediaerror = function (el) {
    const item = el.closest && el.closest(".mediaitem");
    if (!item) { el.style.opacity = "0.2"; return; }
    item.style.aspectRatio = "4 / 3";
    item.classList.add("mediaerror");
    item.innerHTML = '<div class="mederrface">:(</div><div class="mederrnote">media removed</div>';
};

window.onavatarerror = function (img) {
    const placeholder = document.createElement("div");
    const classes = (img.className || "").split(/\s+/).filter(Boolean);
    for (const c of classes) placeholder.classList.add(c);
    placeholder.classList.add("avatarerror");
    placeholder.textContent = ":(";
    img.replaceWith(placeholder);
};

const CFG = Object.assign({
    kind: "community",
    param: "community",
    index: "communities.json",
    indexkey: "communities",
    matchkey: "folder",
    titlesuffix: "community archive",
}, window.ARCHIVE || {});

const params = new URLSearchParams(location.search);
// standalone export: fall back to the single bundled profile when no query param.
const collectionname = params.get(CFG.param) || params.get("c") || CFG.defaultcollection || "";
if (collectionname && params.get("c") && !params.get(CFG.param)) {
    const u = new URL(location.href);
    u.searchParams.delete("c");
    u.searchParams.set(CFG.param, collectionname);
    history.replaceState(null, "", u);
}
// tabs are whatever the html declares..
const validtabs = [...document.querySelectorAll(".tabs .tab")].map(t => t.dataset.tab);
const initialtab = validtabs.includes(params.get("tab")) ? params.get("tab") : (validtabs[0] || "top");
const initialquery = params.get("q") || "";
const initialfocus = params.get("tweet") || "";

/*//////////////////////////////////////////////////////////////////////*/

const state = {
    community: null,
    tweets: [], users: [],
    userbyid: new Map(), byid: new Map(),
    repliesbyparent: new Map(),
    quotecache: new Map(),
    countsbytab: {top: 0, tweets: 0, replies: 0, media: 0, users: 0},
    tab: initialtab, filtered: [],
    rendered: 0, pagesize: 25,
    loading: false,
};

const viewlist = document.querySelector(".viewlist");
const viewdetail = document.querySelector(".viewdetail");
const headerel   = viewlist.querySelector(".headerwrap");
const statusel   = viewlist.querySelector(".status");
const feedel     = viewlist.querySelector(".feed");
const tabsel     = viewlist.querySelector(".tabs");
const searchel   = viewlist.querySelector(".search");
const footerel   = viewlist.querySelector(".endmark");
const searchinput = viewlist.querySelector(".searchinput");
const resultcountel = viewlist.querySelector(".resultcount");
const detailbackbtn = viewdetail.querySelector(".detailback");
const detailbodyel  = viewdetail.querySelector(".detailbody");
detailbackbtn.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.4 13 12.5 18l-1.4 1.4L3.6 12l7.5-7.5 1.4 1.5L7.4 11H21v2z"/></svg>';

/*//////////////////////////////////////////////////////////////////////*/

if (!collectionname) {
    tabsel.hidden = true; searchel.hidden = true;
    statusel.className = "status empty";
    statusel.innerHTML =
        '<div class="emptystate">' +
            '<div class="mederrface">:(</div>' +
            '<div>no ' + CFG.kind + ' selected.<br><a href="./">browse the list</a></div>' +
        '</div>';
} else {
    init();
}

async function init() {
    const folder = encodeURIComponent(collectionname);
    try {
        statusel.textContent = "loading " + CFG.kind + "...";
        const idxres = await fetch(CFG.index);
        if (!idxres.ok) throw new Error(CFG.index + " HTTP " + idxres.status);
        const idx = await idxres.json();
        const c = (idx[CFG.indexkey] || []).find(x => x[CFG.matchkey] === collectionname);
        if (!c) throw new Error(CFG.kind + " " + collectionname + " not found. like georgenotfound. since you got this error message likely through messing around this is your punishment");
        state.community = c;
        state.ownerid = CFG.kind === "profile" ? (c.id || "") : "";
        renderheader(c);
        document.title = c.name + " - " + CFG.titlesuffix;

        tabsel.hidden = false; searchel.hidden = false;
        wireup();
        switchtab(state.tab, /*pushState*/false);
        if (initialquery) { searchinput.value = initialquery; }
        if (initialfocus) {
            viewlist.hidden = true;
            viewdetail.hidden = false;
            detailbodyel.innerHTML = '<div class="detail"><div class="placeholder">loading...</div></div>';
        }

        startloadprogress();
        const usersurl  = folder + "/users.json";
        const tweetsurl = folder + "/tweets.json";
        const [usersblob, tweetsblob] = await Promise.all([
            fetchwithprogress(usersurl,  "users"),
            fetchwithprogress(tweetsurl, "tweets"),
        ]);
        statusel.remove();
        state.users = JSON.parse(usersblob);
        for (const u of state.users) state.userbyid.set(u.id, u);
        const tweets = JSON.parse(tweetsblob);
        ingesttweets(tweets);
        await seedlinkcards(folder);
        updatetabcounts();
        applyfilter();
        if (initialfocus) setTimeout(() => opentweetdetail(initialfocus, {push: false}), 0);
        finishloadprogress();
    } catch (e) {
        if (statusel.parentNode) {
            statusel.className = "err";
            statusel.textContent = "failed to load: " + e.message;
        }
        console.error(e);
    }
}

// standalone export: link-card metadata is baked at archive time so embeds
// render offline. anything not baked still falls back to a live fetch.
async function seedlinkcards(folder) {
    try {
        const r = await fetch(folder + "/cards.json");
        if (!r.ok) return;
        const cards = await r.json();
        if (!state.linkcardcache) state.linkcardcache = new Map();
        for (const [url, meta] of Object.entries(cards)) {
            if (meta) state.linkcardcache.set(url, meta);
        }
    } catch (e) {}
}

/*//////////////////////////////////////////////////////////////////////*/

const loadprog = {totals: new Map(), loaded: new Map(), el: null, bar: null, label: null};

function startloadprogress() {
    const el = document.createElement("div");
    el.className = "loadprog";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;height:2px;z-index:50;background:transparent;pointer-events:none;opacity:1";
    const bar = document.createElement("div");
    bar.className = "loadprogbar";
    bar.style.cssText = "height:100%;background:var(--accent);transition:width 0.2s;width:0%";
    el.appendChild(bar);
    const label = document.createElement("div");
    label.className = "loadproglabel";
    label.style.cssText = "position:fixed;top:6px;right:8px;background:rgba(0,0,0,0.7);color:var(--text);padding:3px 9px;border-radius:6px;font-size:11px;z-index:50;pointer-events:none;opacity:1";
    label.textContent = "loading...";
    document.body.appendChild(el);
    document.body.appendChild(label);
    loadprog.el = el; loadprog.bar = bar; loadprog.label = label;
}
function updateloadprogress() {
    if (!loadprog.bar) return;
    let total = 0, loaded = 0, unknown = false;
    for (const v of loadprog.totals.values()) { if (!v) unknown = true; total += v; }
    for (const v of loadprog.loaded.values())  loaded += v;
    const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
    loadprog.bar.style.width = (unknown && pct < 5 ? 3 : pct) + "%";
    if (loadprog.label) loadprog.label.textContent = fmtbytes(loaded) + (total ? " / " + fmtbytes(total) : "");
}
function finishloadprogress() {
    if (!loadprog.el) return;
    loadprog.bar.style.width = "100%";
    loadprog.label.style.transition = "opacity 0.4s 0.6s";
    loadprog.label.style.opacity = "0";
    setTimeout(() => {
        if (loadprog.el) loadprog.el.remove();
        if (loadprog.label) loadprog.label.remove();
        loadprog.el = loadprog.bar = loadprog.label = null;
    }, 1400);
}

async function fetchwithprogress(url, key) {
    const cangz = typeof DecompressionStream !== "undefined";
    if (cangz) {
        try {
            const r = await fetch(url + ".gz");
            if (r.ok && r.body) {
                return await consumegzipbody(r, key);
            }
        } catch (e) {}
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " HTTP " + r.status);
    return await consumeplainbody(r, key);
}

async function consumeplainbody(r, key) {
    const total = parseInt(r.headers.get("content-length") || "0", 10) || 0;
    loadprog.totals.set(key, total);
    loadprog.loaded.set(key, 0);
    updateloadprogress();
    if (!r.body || !r.body.getReader) {
        const t = await r.text();
        loadprog.loaded.set(key, t.length);
        updateloadprogress();
        return t;
    }
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        loadprog.loaded.set(key, received);
        updateloadprogress();
    }
    const total2 = chunks.reduce((a, b) => a + b.length, 0);
    const all = new Uint8Array(total2);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return new TextDecoder("utf-8").decode(all);
}

async function consumegzipbody(r, key) {
    const total = parseInt(r.headers.get("content-length") || "0", 10) || 0;
    loadprog.totals.set(key, total);
    loadprog.loaded.set(key, 0);
    updateloadprogress();
    const counter = new TransformStream({
        transform(chunk, controller) {
            loadprog.loaded.set(key, (loadprog.loaded.get(key) || 0) + chunk.length);
            updateloadprogress();
            controller.enqueue(chunk);
        },
    });
    const stream = r.body.pipeThrough(counter).pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
}

function ownsfeed(t) {
    return !(CFG.kind === "profile" && state.ownerid) || t.user_id === state.ownerid;
}

function ingesttweets(tweets) {
    for (const t of tweets) {
        state.tweets.push(t);
        state.byid.set(t.id, t);
        const isreply = !!(t.in_reply_to && t.in_reply_to.status_id);
        if (isreply) {
            const pid = t.in_reply_to.status_id;
            let arr = state.repliesbyparent.get(pid);
            if (!arr) { arr = []; state.repliesbyparent.set(pid, arr); }
            arr.push(t);
        }
        if (!ownsfeed(t)) continue;
        if (isreply) state.countsbytab.replies++;
        else         state.countsbytab.tweets++;
        if (t.media && t.media.length) state.countsbytab.media++;
        state.countsbytab.top++;
    }
    state.countsbytab.users = state.users.length;
}

/*//////////////////////////////////////////////////////////////////////*/

function renderheader(meta) {
    if (CFG.kind === "profile") renderheaderprofile(meta);
    else renderheadercommunity(meta);
    hydrateunresolvedtco(headerel);
    emojify(headerel);
}

function renderheadercommunity(meta) {
    const folder = encodeURIComponent(collectionname);
    // try webp first or fall back to jpg if i have it
    const bannerhtml =
        '<div class="bannerwrap">' +
        '<img src="' + folder + '/banner.webp" ' +
        'onerror="if (this.dataset.fb) {this.remove(); return} this.dataset.fb=1; this.src=\'' + folder + '/banner.jpg\'">' +
        '</div>';

    let deschtml = "";
    if (meta.description) deschtml = '<p class="desc">' + decodeandescape(meta.description) + '</p>';
    const fullmembers = meta.full_user_count ? '<span><b>' + fmtcountshort(meta.full_user_count) + '</b> total members</span>' : '';

    headerel.innerHTML =
        '<div class="header">' +
        bannerhtml +
        '<div class="headerinfo">' +
        '<h1 class="name">' + decodeandescape(meta.name) + '</h1>' +
        deschtml +
        (fullmembers ? '<div class="metarow">' + fullmembers + '</div>' : '') +
        '</div>' +
        '</div>';
}

function renderheaderprofile(meta) {
    const bannerhtml = meta.banner
        ? '<div class="pbanner"><img src="' + escapeattr(mediaurl(meta.banner)) + '" referrerpolicy="no-referrer" onerror="this.remove()"></div>'
        : '<div class="pbanner"></div>';
    const avatarhtml = meta.avatar
        ? '<div class="pavatarwrap"><img src="' + escapeattr(mediaurl(meta.avatar)) + '" referrerpolicy="no-referrer" onerror="window.onavatarerror(this)"></div>'
        : '<div class="pavatarwrap"></div>';
    const verifiedhtml = meta.verified ? iconverified : "";

    const biohtml = meta.bio ? '<div class="pbio">' + formattext(meta.bio) + '</div>' : "";

    const metaparts = [];
    if (meta.location) metaparts.push('<span class="pmetaitem">' + iconlocationp + decodeandescape(meta.location) + '</span>');
    if (meta.url_expanded || meta.url) {
        const href = meta.url_expanded || meta.url;
        const shown = (meta.url_expanded || meta.url).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
        metaparts.push('<span class="pmetaitem">' + iconlinkp +
            '<a href="' + escapeattr(href) + '" target="_blank" rel="noopener">' + escapehtml(shown) + '</a></span>');
    }
    if (meta.created_at) {
        metaparts.push('<span class="pmetaitem">' + iconcalendar + 'Joined ' + escapehtml(fmtjoined(meta.created_at)) + '</span>');
    }
    const metahtml = metaparts.length ? '<div class="pmeta">' + metaparts.join("") + '</div>' : "";

    const statshtml =
        '<div class="pstats">' +
        '<span><b>' + fmtcountshort(meta.following || 0) + '</b> Following</span>' +
        '<span><b>' + fmtcountshort(meta.followers || 0) + '</b> Followers</span>' +
        (meta.posts ? '<span><b>' + fmtcountshort(meta.posts) + '</b> Tweets</span>' : '') +
        '</div>';

    const folder = encodeURIComponent(collectionname);
    const fileshtml =
        '<div class="pfiles">' +
        '<a href="' + folder + '/tweets.json" download>tweets.json' + (meta.tweets_size ? '<small>' + escapehtml(meta.tweets_size) + '</small>' : '') + '</a>' +
        '<a href="' + folder + '/users.json" download>users.json' + (meta.users_size ? '<small>' + escapehtml(meta.users_size) + '</small>' : '') + '</a>' +
        '</div>';

    headerel.innerHTML =
        '<div class="header profileheader">' +
        bannerhtml +
        '<div class="pinfo">' +
        avatarhtml +
        '<div class="pnamewrap">' +
        '<span class="pnamerow"><span class="dname">' + decodeandescape(meta.name) + '</span>' + verifiedhtml + '</span>' +
        '<div class="phandle">@' + escapehtml(meta.handle || collectionname) + '</div>' +
        '</div>' +
        biohtml + metahtml + statshtml + fileshtml +
        '</div>' +
        '</div>';
}

/*//////////////////////////////////////////////////////////////////////*/

function wireup() {
    for (const t of tabsel.querySelectorAll(".tab")) {
        t.addEventListener("click", () => switchtab(t.dataset.tab, true));
    }
    let pending = null;
    searchinput.addEventListener("input", () => {
        clearTimeout(pending);
        pending = setTimeout(applyfilter, 80);
    });
    window.addEventListener("scroll", () => {
        if (state.loading) return;
        const docel = document.documentElement;
        if (docel.scrollTop + docel.clientHeight >= docel.scrollHeight - 600) {
            rendernextpage();
        }
    });
}

function switchtab(name, push) {
    state.tab = name;
    for (const t of tabsel.querySelectorAll(".tab")) {
        t.classList.toggle("active", t.dataset.tab === name);
    }
    const placeholderbytab = {
        top:     "Search top tweets...",
        tweets:  "Search tweets...",
        replies: "Search replies...",
        media:   "Search media tweets...",
        users:   "Search members",
    };
    searchinput.placeholder = placeholderbytab[name] || "Search";
    if (push) {
        const url = new URL(location.href);
        url.searchParams.set("tab", name);
        history.replaceState(null, "", url);
    }
    applyfilter();
}

/*//////////////////////////////////////////////////////////////////////*/

function updatetabcounts() {
    const c = state.countsbytab;
    for (const tab of validtabs) {
        const el = document.querySelector('.tab[data-tab="' + tab + '"] .count');
        if (el) el.textContent = fmtnum(c[tab] || 0);
    }
}

function tabfilter(tab) {
    if (tab === "users")   return state.users;
    const pool = (CFG.kind === "profile" && state.ownerid)
        ? state.tweets.filter(ownsfeed)
        : state.tweets;
    if (tab === "replies") return pool.filter(t => t.in_reply_to && t.in_reply_to.status_id);
    if (tab === "media")   return pool.filter(t => t.media && t.media.length);
    if (tab === "top")     return pool.slice();
    return pool.filter(t => !(t.in_reply_to && t.in_reply_to.status_id));
}

/*//////////////////////////////////////////////////////////////////////*/

// rerun and sort
function updatefiltered() {
    const q = searchinput.value || "";
    const pool = tabfilter(state.tab);
    const ctx = {userbyid: state.userbyid, byid: state.byid};
    if (state.tab === "users") {
        const sp = parseuserquery(q);
        state.filtered = pool.filter(u => matchuser(u, sp));
        state.filtered.sort((a, b) => (b.followers || 0) - (a.followers || 0));
    } else if (state.tab === "top") {
        const sp = parsetweetquery(q);
        state.filtered = pool.filter(t => matchtweet(t, sp, ctx));
        state.filtered.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else {
        const sp = parsetweetquery(q);
        state.filtered = pool.filter(t => matchtweet(t, sp, ctx));
        state.filtered.sort((a, b) => parsedate(b.created_at) - parsedate(a.created_at));
    }
    // only show the count when there's an actual search going on
    resultcountel.textContent = q.trim()
        ? fmtnum(state.filtered.length) + " result" + (state.filtered.length === 1 ? "" : "s")
        : "";
    if (state.rendered < state.filtered.length) footerel.hidden = true;
}

function applyfilter() {
    updatefiltered();
    state.rendered = 0;
    feedel.innerHTML = "";
    footerel.hidden = true;
    rendernextpage();
    const q = searchinput.value || "";
    const url = new URL(location.href);
    if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
    history.replaceState(null, "", url);
}

/*//////////////////////////////////////////////////////////////////////*/

function rendernextpage() {
    if (state.loading) return;
    if (state.rendered >= state.filtered.length) {
        footerel.hidden = state.rendered === 0;
        return;
    }
    state.loading = true;
    const frag = document.createDocumentFragment();
    const target = Math.min(state.filtered.length, state.rendered + state.pagesize);
    for (let i = state.rendered; i < target; i++) {
        const item = state.filtered[i];
        const tab = state.tab;
        const istweettab = tab !== "users";
        frag.appendChild(istweettab ? rendertweet(item) : renderuser(item));
    }
    feedel.appendChild(frag);
    state.rendered = target;
    state.loading = false;
    if (state.rendered >= state.filtered.length) footerel.hidden = false;
    observelazyelements();
}

/*//////////////////////////////////////////////////////////////////////*/

const lazyobserver = ("IntersectionObserver" in window)
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const el = e.target;
            lazyobserver.unobserve(el);
            if (el.classList.contains("quoted") && el.getAttribute("data-quote-id")) {
                hydratequote(el);
            } else if (el.classList.contains("linkcard") && el.getAttribute("data-card-url")) {
                hydratelinkcard(el);
            }
        }
    }, {rootMargin: "600px 0px"})
    : null;

function observelazyelements() {
    observelazyin(feedel);
    observelazyin(detailbodyel);
}
function observelazyin(root) {
    if (!lazyobserver || !root) return;
    for (const el of root.querySelectorAll(".quoted[data-quote-id]:not([data-lazy-watched])")) {
        el.setAttribute("data-lazy-watched", "1");
        lazyobserver.observe(el);
    }
    for (const el of root.querySelectorAll(".linkcard[data-card-url]:not([data-lazy-watched])")) {
        el.setAttribute("data-lazy-watched", "1");
        lazyobserver.observe(el);
    }
    // ACTUAL autoplay now
    if (videovisibilityobserver) {
        for (const v of root.querySelectorAll("video:not([data-vis-watched])")) {
            v.setAttribute("data-vis-watched", "1");
            videovisibilityobserver.observe(v);
        }
    }
}

// (if halfway on screen)
const videovisibilityobserver = ("IntersectionObserver" in window)
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
            const v = e.target;
            if (e.isIntersecting && e.intersectionRatio >= 0.5) {
                const pr = v.play();
                if (pr && pr.catch) pr.catch(() => {});
            } else if (!v.paused) {
                v.pause();
            }
        }
    }, {threshold: [0, 0.5]})
    : null;

async function hydratequote(el) {
    const id = el.getAttribute("data-quote-id");
    if (!id) return;
    let q = state.byid.get(id) || state.quotecache.get(id);
    if (q === undefined || q === null) q = await fetchsyndicatedtweet(id);
    if (!q) {
        const qtext = el.querySelector(".qtext");
        if (qtext) qtext.textContent = "could not load quoted tweet";
        return;
    }
    const replacement = document.createElement("template");
    replacement.innerHTML = renderquotedcard(q).trim();
    const newel = replacement.content.firstChild;

    el.replaceWith(newel);
    newel.setAttribute("data-lazy-watched", "1");
    newel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        opentweetdetail(q.id);
    });
    hydrateunresolvedtco(newel);
    emojify(newel);
}

/*//////////////////////////////////////////////////////////////////////*/

async function hydratelinkcard(el) {
    const url = el.getAttribute("data-card-url");
    if (!url) return;
    if (!state.linkcardcache) state.linkcardcache = new Map();
    if (state.linkcardcache.has(url)) {
        const cached = state.linkcardcache.get(url);
        if (cached) applylinkcardmeta(el, cached);
        return;
    }
    const meta = await fetchlinkmeta(url);
    state.linkcardcache.set(url, meta);
    if (meta && (meta.title || meta.image)) applylinkcardmeta(el, meta);
}

async function fetchlinkmeta(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
            const yt = await fetchyoutubemeta(url);
            if (yt) return yt;
        }
    } catch (e) {}
    try {
        const r = await fetch(url, {headers: {"Accept": "text/html, */*"}});
        if (r.ok) {
            const html = await r.text();
            const meta = parseopengraph(html);
            if (meta && (meta.title || meta.image)) return meta;
        }
    } catch (e) {}
    try {
        const r = await fetch(corsproxy + encodeURIComponent(url), {
            headers: {"Accept": "text/html, */*"},
        });
        if (!r.ok) return null;
        const html = await r.text();
        return parseopengraph(html);
    } catch (e) { return null; }
}

async function fetchyoutubemeta(url) {
    const endpoint = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url);
    try {
        const r = await fetch(endpoint);
        if (!r.ok) return null;
        const j = await r.json();
        return {
            title:       j.title || "",
            description: j.author_name || "",
            image:       j.thumbnail_url || "",
            site:        "YouTube",
        };
    } catch (e) { return null; }
}

function parseopengraph(html) {
    // first 32kb of page head element
    const head = html.slice(0, html.indexOf("</head>") + 7 || 32768);
    const out = {};
    const meta = head.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of meta) {
        const propm = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
        const contm = tag.match(/content\s*=\s*["']([^"']+)["']/i);
        if (!propm || !contm) continue;
        const key = propm[1].toLowerCase();
        const val = contm[1];
        if (key === "og:title"       || key === "twitter:title")        out.title       = out.title       || val;
        if (key === "og:description" || key === "twitter:description"
            || key === "description")                                    out.description = out.description || val;
        if (key === "og:image"       || key === "twitter:image"
            || key === "twitter:image:src")                              out.image       = out.image       || val;
        if (key === "og:site_name")                                      out.site        = out.site        || val;
    }
    // ..or title as a fallback?
    if (!out.title) {
        const t = head.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (t) out.title = t[1].trim();
    }
    return out;
}

function applylinkcardmeta(el, meta) {
    const url = el.getAttribute("data-card-url") || el.getAttribute("href");
    let domain = "";
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
    let html = "";
    if (meta.image) {
        html += '<img class="lcthumb" src="' + escapeattr(meta.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
    }
    const title = meta.title ? '<div class="lctitle">' + decodeandescape(meta.title) + '</div>' : "";
    const desc  = meta.description ? '<div class="lcdesc">' + decodeandescape(meta.description) + '</div>' : "";
    html += '<div class="lcbody">' +
            '<div class="lcdomain">' + escapehtml(domain) + '</div>' +
            title + desc +
            '</div>';
    el.classList.add("rich");
    el.innerHTML = html;
    emojify(el);
}

function rendertweet(t, opts) {
    opts = opts || {};
    const article = document.createElement("article");
    article.className = "tweet";
    article.setAttribute("data-tweet-id", t.id);
    const u = state.userbyid.get(t.user_id) || t.syndicateduser || {};
    const avatar = u.avatar
        ? '<img class="avatar" src="' + escapeattr(mediaurl(u.avatar)) + '" loading="lazy" referrerpolicy="no-referrer" onerror="window.onavatarerror(this)">'
        : '<div class="avatar"></div>';
    const {strippednames, remainder} = stripleadingmentions(t);
    const replytargets = strippednames.length
        ? strippednames
        : (t.in_reply_to && t.in_reply_to.screen_name ? [t.in_reply_to.screen_name] : []);
    const replyinghtml = (!opts.suppressreplying && replytargets.length)
        ? '<div class="replying">Replying to ' + replytargets.map(name =>
            '<a href="https://x.com/' + escapeattr(name) + '" target="_blank" rel="noopener">@' + escapehtml(name) + '</a>'
            ).join(", ") + '</div>'
        : "";

    const dname = decodeandescape(u.display_name || u.username || "(unknown)");
    const handle = u.username ? "@" + u.username : "@" + (t.user_id || "?");
    const verifiedhtml = u.verified ? iconverified : "";
    const syndhtml = t.syndicated ? '<span class="syndtag">(not from the dataset)</span>' : "";

    const datestr = fmtdate(t.created_at);
    const datealt = (t.created_at || "").replace(/\s*\+0000\s*/, " ");
    const tweeturl = tweeturlfor(t);

    const mediahtml = rendermedia(t.media);
    const linkcardhtml = renderlinkcard(t);
    const quotedhtml = renderquotedplaceholder(t);
    const linkcardurl = picklinkcardurl(t);
    const texthtml = '<div class="text">' + formattweettext({...t, text: remainder}, linkcardurl) + '</div>';

    article.innerHTML =
        avatar +
        '<div class="content">' +
        '<div class="row1">' +
        '<span class="dname">' + dname + '</span>' +
        verifiedhtml +
        '<span class="handle">' + escapehtml(handle) + '</span>' +
        syndhtml +
        '<span class="dot">·</span>' +
        '<a class="date" href="' + tweeturl + '" target="_blank" rel="noopener" title="' + escapeattr(datealt) + '">' + datestr + '</a>' +
        '</div>' +
        replyinghtml +
        '<div class="tweetbody">' +
        texthtml +
        mediahtml +
        linkcardhtml +
        quotedhtml +
        '</div>' +
        renderactions(t) +
        '</div>';

    for (const a of article.querySelectorAll(".mediaitem")) {
        if (!a.classList.contains("video")) a.addEventListener("click", onmediaclick);
    }
    article.addEventListener("click", (e) => {
        if (e.target.closest("a, button, video, .mediaitem, .quoted, .linkcard, .action")) return;
        if (t.syndicated) {
            window.open(tweeturl, "_blank", "noopener");
            return;
        }
        opentweetdetail(t.id);
    });
    const q = article.querySelector(".quoted");
    if (q && t.quoted_id) {
        q.addEventListener("click", (e) => {
            e.stopPropagation();
            opentweetdetail(t.quoted_id);
        });
    }
    for (const m of article.querySelectorAll(".mediagrid.n1 .mediaitem img, .mediagrid.n1 .mediaitem video")) {
        wiren1aspect(m);
    }
    hydrateunresolvedtco(article);
    emojify(article);
    return article;
}

/*//////////////////////////////////////////////////////////////////////*/

// this one is pretty cool! maybe request intensive but at least i don't have to do that myself in the dataset
// would it be better to still run a script to unshorten them? yeah
// am i gonna do it?                            nn  o
if (!window.tcocache) window.tcocache = new Map();
const tcocache = window.tcocache;
const tcoinflight = new Map();

async function hydrateunresolvedtco(root) {
    if (!root) return;
    const targets = root.querySelectorAll(".unresolvedtco:not([data-resolving])");
    for (const a of targets) {
        const tco = a.getAttribute("data-tco");
        if (!tco) continue;
        a.setAttribute("data-resolving", "1");
        resolvetco(tco).then((expanded) => {
            if (!expanded) {
                a.classList.add("resolved");
                a.textContent = tco.replace(/^https?:\/\//, "");
                return;
            }
            a.href = expanded;
            const pretty = expanded.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
            a.textContent = pretty.length > 48 ? pretty.slice(0, 48) + "..." : pretty;
            a.classList.add("resolved");
            tcocache.set(tco, expanded);
        }).catch(() => {
            a.classList.add("resolved");
        });
    }
}

async function resolvetco(tco) {
    if (tcocache.has(tco)) return tcocache.get(tco);
    if (tcoinflight.has(tco)) return tcoinflight.get(tco);
    const p = (async () => {
        try {
            const r = await fetch(corsproxy + encodeURIComponent(tco));
            if (!r.ok) return null;
            const html = await r.text();
            // first 16kb holds the redirect signals
            const head = html.slice(0, 16384);
            let dest =
                    (head.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1]
                || (head.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) || [])[1]
                || (head.match(/<meta\s+http-equiv=["']refresh["'][^>]+content=["'][^"']*?url=([^"']+)["']/i) || [])[1]
                || (head.match(/<noscript>\s*<META\s+http-equiv=["']refresh["'][^>]+content=["'][^"']*?URL=([^"']+)["']/i) || [])[1];
            if (dest) {
                try { dest = new URL(dest, tco).href; } catch (e) {}
            }
            return dest || null;
        } catch (e) { return null; }
    })();
    tcoinflight.set(tco, p);
    const res = await p;
    tcoinflight.delete(tco);
    tcocache.set(tco, res);
    return res;
}

function wiren1aspect(m) {
    const item = m.closest(".mediaitem");
    if (!item) return;
    const isvideo = m.tagName === "VIDEO";
    const ready = () => applyn1aspect(item, m);
    if (isvideo) {
        if (m.readyState >= 1 && m.videoWidth) ready();
        else m.addEventListener("loadedmetadata", ready, {once: true});
    } else {
        if (m.complete && m.naturalWidth) ready();
        else m.addEventListener("load", ready, {once: true});
    }
}

/*//////////////////////////////////////////////////////////////////////*/

function stripleadingmentions(t) {
    const stripped = [];
    let s = t.text || "";
    if (!(t.in_reply_to && t.in_reply_to.status_id)) return {strippednames: stripped, remainder: s};
    const chainset = new Set((t.mentions || []).map(m => m.toLowerCase()));
    if (t.in_reply_to.screen_name) chainset.add(t.in_reply_to.screen_name.toLowerCase());
    while (true) {
        const m = s.match(/^@([A-Za-z0-9_]+)\s+/);
        if (!m) break;
        if (!chainset.has(m[1].toLowerCase())) break;
        stripped.push(m[1]);
        s = s.slice(m[0].length);
    }
    return {strippednames: stripped, remainder: s};
}

// between 2:3 and 16:9 (img or video)
function applyn1aspect(item, m) {
    if (!item) return;
    const w = m.naturalWidth  || m.videoWidth  || 0;
    const h = m.naturalHeight || m.videoHeight || 0;
    if (!w || !h) return;
    const a = w / h;
    const min = 2 / 3;
    const max = 16 / 9;
    if (a > max) {
        item.style.aspectRatio = "16 / 9";
        item.classList.add("cover");
    } else if (a < min) {
        item.style.aspectRatio = "2 / 3";
        item.classList.add("cover");
    } else {
        item.style.aspectRatio = a.toFixed(4);
        item.classList.remove("cover");
    }
}

function renderquotedplaceholder(t) {
    if (!t.quoted_id) return "";
    const local = state.byid.get(t.quoted_id);
    if (local) return renderquotedcard(local);
    return '<div class="quoted" data-quote-id="' + escapeattr(t.quoted_id) + '">' +
        '<div class="qheader"><div class="qavatar"></div><b>quoted tweet</b><span class="qhandle">id ' + escapehtml(t.quoted_id) + '</span></div>' +
        '<div class="qtext">loading!</div>' +
        '</div>';
}

function renderquotedcard(q) {
    const u = state.userbyid.get(q.user_id) || q.syndicateduser || {};
    const avatarhtml = u.avatar
        ? '<img class="qavatar" src="' + escapeattr(mediaurl(u.avatar)) + '" referrerpolicy="no-referrer" onerror="window.onavatarerror(this)">'
        : '<div class="qavatar"></div>';
    const handle = u.username ? "@" + u.username : "@?";
    const mediahtml = rendermedia(q.media);
    return '<div class="quoted" data-quote-id="' + escapeattr(q.id) + '">' +
        '<div class="qheader">' + avatarhtml +
        '<b>' + decodeandescape(u.display_name || u.username || "(unknown)") + '</b>' +
        '<span class="qhandle">' + escapehtml(handle) + '</span>' +
        (q.syndicated ? '<span class="syndtag">(not from the dataset)</span>' : '') +
        '</div>' +
        '<div class="qtext">' + formattweettext(q) + '</div>' +
        mediahtml +
        '</div>';
}

function rendermedia(media) {
    if (!media || !media.length) return "";
    const items = media.slice(0, 4);
    const n = items.length;
    const inner = items.map(m => {
        const thumb = mediaurl(m.thumbnail || "");
        const small = smallimg(thumb);
        // inline video
        if ((m.type === "video" || m.type === "animated_gif") && m.video_url) {
            const isgif = m.type === "animated_gif";
            const attrs = isgif
                ? 'loop muted playsinline preload="metadata"'
                : 'controls muted playsinline preload="metadata"';
            return '<div class="mediaitem video">' +
                '<video ' + attrs + ' poster="' + escapeattr(small) + '" src="' + escapeattr(mediaurl(m.video_url)) + '" onerror="window.onmediaerror(this)"></video>' +
                '</div>';
        }
        // pics
        const orig = origimg(thumb);
        const dataattrs =
            ' data-orig="' + escapeattr(orig) + '"' +
            ' data-type="' + escapeattr(m.type || "photo") + '"';
        return '<div class="mediaitem"' + dataattrs + ' role="button" tabindex="0">' +
            '<img src="' + escapeattr(small) + '" loading="lazy" referrerpolicy="no-referrer" onerror="window.onmediaerror(this)">' +
            '</div>';
    }).join("");
    return '<div class="mediagrid n' + n + '">' + inner + '</div>';
}

function picklinkcardurl(t) {
    const urls = t.urls || [];
    if (!urls.length) return "";
    const first = urls.find(u => u && u.expanded && u.short);
    if (!first) return "";
    if (t.quoted_url && first.expanded === t.quoted_url) return "";
    try {
        const h = new URL(first.expanded).hostname.toLowerCase();
        if (/(^|\.)(x|twitter)\.com$/.test(h)) return "";
    } catch (e) { return ""; }
    return first.short;
}

function renderlinkcard(t) {
    const shorturl = picklinkcardurl(t);
    if (!shorturl) return "";
    const entry = (t.urls || []).find(u => u && u.short === shorturl);
    if (!entry) return "";
    const url = entry.expanded;
    let domain = "";
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
    if (!domain) return "";
    const favicon = '<img class="lcicon" src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=64" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">';
    const trunc = url.length > 64 ? url.slice(0, 64) + "..." : url;
    return '<a class="linkcard" data-card-url="' + escapeattr(url) + '" href="' + escapeattr(url) + '" target="_blank" rel="noopener">' +
        favicon +
        '<div class="lcbody">' +
        '<div class="lcdomain">' + escapehtml(domain) + '</div>' +
        '<div class="lcurl">' + escapehtml(trunc) + '</div>' +
        '</div></a>';
}

/*//////////////////////////////////////////////////////////////////////*/

// compressed svgs borrowed from an unreleased project
const iconreply   = '<path d="M1.8 10a8 8 0 0 1 8-8H14a8.1 8.1 0 0 1 4 15.2l-8 4.5V18a8 8 0 0 1-8.2-8m8-6a6 6 0 1 0 0 12H12v2.3l5-2.8A6.1 6.1 0 0 0 14.2 4z"/>';
const iconretweet = '<path d="M4.5 3.9 8.9 8 7.6 9.5l-2.1-2V16q.2 1.8 2 2H13v2H7.5a4 4 0 0 1-4-4V7.6l-2 1.9L0 8zm12 2.1H11V4h5.5a4 4 0 0 1 4 4v8.5l2-2L24 16l-4.5 4-4.4-4 1.3-1.5 2.1 2V8a2 2 0 0 0-2-2"/>';
const iconlike    = '<path d="M16.7 5.5q-2-.2-3.9 2.2l-.8 1-.8-1q-2-2.4-3.9-2.2t-3 2Q3.5 9 5 12.1q1.4 3 7.1 6.6a19 19 0 0 0 7.1-6.6c1.1-2 1-3.7.5-4.8a3 3 0 0 0-2.9-1.9m4.2 7.7q-2 3.8-8.4 7.7l-.5.3-.5-.3q-6.4-4-8.4-7.7-1.9-3.9-.5-6.7 1.5-2.8 4.6-3 2.6 0 4.8 2a6 6 0 0 1 4.8-2q3.1.2 4.6 3t-.5 6.7"/>';
const iconviews   = '<path d="M8.75 21V3h2v18zM18 21V8.5h2V21zM4 21l.004-10h2L6 21zm9.25 0v-7h2v7z"/>';

const iconverified = '<svg class="checkmark" viewBox="0 0 22 22"><path fill="#1d9bf0" d="M20.4 11a4 4 0 0 0-2-3 4 4 0 0 0-.8-3.6 4 4 0 0 0-3.5-.8 4 4 0 0 0-3.1-2 4 4 0 0 0-3 2 4 4 0 0 0-3.6.8 4 4 0 0 0-.8 3.5 4 4 0 0 0-2 3.1 4 4 0 0 0 2 3 4 4 0 0 0 .8 3.6 4 4 0 0 0 3.5.8 4 4 0 0 0 3.1 2 4 4 0 0 0 3-2 3.3 3.3 0 0 0 4.4-4.3 4 4 0 0 0 2-3.1M9.7 14.9l-3.5-3.5 1.3-1.3 2.1 2L14 7.5l1.3 1.2z"/></svg>';
const iconlocation = '<svg class="umetaicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 7c-1.93 0-3.5 1.57-3.5 3.5S10.07 14 12 14s3.5-1.57 3.5-3.5S13.93 7 12 7zm0 5c-.827 0-1.5-.673-1.5-1.5S11.173 9 12 9s1.5.673 1.5 1.5S12.827 12 12 12zm0-10c-4.687 0-8.5 3.813-8.5 8.5 0 5.967 7.621 11.116 7.945 11.332l.555.37.555-.37c.324-.216 7.945-5.365 7.945-11.332C20.5 5.813 16.687 2 12 2zm0 17.77c-1.665-1.241-6.5-5.196-6.5-9.27C5.5 6.916 8.416 4 12 4s6.5 2.916 6.5 6.5c0 4.073-4.835 8.028-6.5 9.27z"/></svg>';
const iconlink     = '<svg class="umetaicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z"/></svg>';

const iconlocationp = '<svg class="pmetaicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 7c-1.93 0-3.5 1.57-3.5 3.5S10.07 14 12 14s3.5-1.57 3.5-3.5S13.93 7 12 7zm0 5c-.827 0-1.5-.673-1.5-1.5S11.173 9 12 9s1.5.673 1.5 1.5S12.827 12 12 12zm0-10c-4.687 0-8.5 3.813-8.5 8.5 0 5.967 7.621 11.116 7.945 11.332l.555.37.555-.37c.324-.216 7.945-5.365 7.945-11.332C20.5 5.813 16.687 2 12 2zm0 17.77c-1.665-1.241-6.5-5.196-6.5-9.27C5.5 6.916 8.416 4 12 4s6.5 2.916 6.5 6.5c0 4.073-4.835 8.028-6.5 9.27z"/></svg>';
const iconlinkp = '<svg class="pmetaicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z"/></svg>';
const iconcalendar = '<svg class="pmetaicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 4V3h2v1h6V3h2v1h1.5C19.89 4 21 5.12 21 6.5v12c0 1.38-1.11 2.5-2.5 2.5h-13C4.12 21 3 19.88 3 18.5v-12C3 5.12 4.12 4 5.5 4H7zm0 2H5.5c-.27 0-.5.22-.5.5v12c0 .28.23.5.5.5h13c.28 0 .5-.22.5-.5v-12c0-.28-.22-.5-.5-.5H17v1h-2V6H9v1H7V6zm0 6h2v-2H7v2zm0 4h2v-2H7v2zm4-4h2v-2h-2v2zm0 4h2v-2h-2v2zm4-4h2v-2h-2v2z"/></svg>';
const iconback = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.4 13 12.5 18l-1.4 1.4L3.6 12l7.5-7.5 1.4 1.5L7.4 11H21v2z"/></svg>';

/*//////////////////////////////////////////////////////////////////////*/

function renderactions(t) {
    const intent = (kind, id) =>
        "https://twitter.com/intent/" + kind +
        (kind === "tweet" ? "?in_reply_to=" : "?tweet_id=") + encodeURIComponent(id);
    const reply = action("reply",   t.replies,  intent("tweet",   t.id), iconreply);
    const rt    = action("retweet", t.retweets, intent("retweet", t.id), iconretweet);
    const lk    = action("like",    t.likes,    intent("like",    t.id), iconlike);
    const vw    = actionstatic("views", t.views, iconviews);
    return '<div class="actions">' + reply + rt + lk + vw + '</div>';
}

function action(cls, n, href, path) {
    const num = (typeof n === "number" && n > 0) ? '<span class="num">' + fmtcountshort(n) + '</span>' : "";
    return '<a class="action ' + cls + '" href="' + escapeattr(href) + '" target="_blank" rel="noopener">' +
        '<span class="icon"><svg viewBox="0 0 24 24">' + path + '</svg></span>' + num + '</a>';
}
function actionstatic(cls, n, path) {
    const num = (typeof n === "number" && n > 0) ? '<span class="num">' + fmtcountshort(n) + '</span>' : "";
    return '<span class="action ' + cls + '">' +
        '<span class="icon"><svg viewBox="0 0 24 24">' + path + '</svg></span>' + num + '</span>';
}

function renderuser(u) {
    const row = document.createElement("div");
    row.className = "userrow";
    const authorhref = u.username ? "https://x.com/" + encodeURIComponent(u.username) : "#";
    const avatarhtml = u.avatar
        ? '<img class="avatar" src="' + escapeattr(mediaurl(u.avatar)) + '" loading="lazy" referrerpolicy="no-referrer" onerror="window.onavatarerror(this)">'
        : '<div class="avatar"></div>';
    const avatarlink = u.username
        ? '<a class="avatarlink" href="' + escapeattr(authorhref) + '" data-from="' + escapeattr(u.username) + '" target="_blank" rel="noopener">' + avatarhtml + '</a>'
        : avatarhtml;
    const verifiedhtml = u.verified ? iconverified : "";
    const biohtml = u.bio ? '<div class="ubio">' + formattext(u.bio) + '</div>' : '';
    const metaparts = [];
    if (u.location) metaparts.push('<span class="umetaitem">' + iconlocation + decodeandescape(u.location) + '</span>');
    if (u.url) {
        const istco = /^https?:\/\/t\.co\//i.test(u.url);
        const linkhtml = istco
            ? '<a class="unresolvedtco" data-tco="' + escapeattr(u.url) + '" href="' + escapeattr(u.url) + '" target="_blank" rel="noopener">(loading...)</a>'
            : '<a href="' + escapeattr(u.url) + '" target="_blank" rel="noopener">' + escapehtml(u.url) + '</a>';
        metaparts.push('<span class="umetaitem">' + iconlink + linkhtml + '</span>');
    }
    const umetahtml = metaparts.length ? '<div class="umeta">' + metaparts.join("") + '</div>' : "";
    row.innerHTML =
        avatarlink +
        '<div class="ubody">' +
        '<div class="row1">' +
        '<a class="dname" data-from="' + escapeattr(u.username || "") + '" href="' + escapeattr(authorhref) + '" target="_blank" rel="noopener">' + decodeandescape(u.display_name || u.username || "") + '</a>' +
        verifiedhtml +
        '<a class="handle handlelink" data-from="' + escapeattr(u.username || "") + '" href="' + escapeattr(authorhref) + '" target="_blank" rel="noopener">@' + escapehtml(u.username || "") + '</a>' +
        '</div>' +
        biohtml +
        umetahtml +
        '<div class="ustats">' +
        '<span><b>' + fmtcountshort(u.followers || 0) + '</b> followers</span>' +
        '<span><b>' + fmtcountshort(u.following || 0) + '</b> following</span>' +
        '<span><b>' + fmtcountshort(u.posts || 0) + '</b> posts</span>' +
        '</div>' +
        '</div>';
    for (const el of row.querySelectorAll("[data-from]")) {
        const from = el.getAttribute("data-from");
        if (!from) continue;
        el.addEventListener("click", (e) => {
            if (e.metaKey || e.ctrlKey || e.button === 1) return;
            e.preventDefault();
            e.stopPropagation();
            switchtab("tweets", true);
            searchinput.value = "from:" + from;
            applyfilter();
        });
    }
    hydrateunresolvedtco(row);
    emojify(row);
    return row;
}

/*//////////////////////////////////////////////////////////////////////*/

function formattext(text) {
    return rendertextsegments(decodeentities(text || ""), null, false);
}
function formattweettext(t, linkcardshorturl) {
    const urlmap = new Map();
    for (const u of (t.urls || [])) {
        if (u && u.short) urlmap.set(u.short, u.expanded || u.short);
    }
    const hasmedia = !!(t.media && t.media.length);
    return rendertextsegments(decodeentities(t.text || ""), urlmap, hasmedia, linkcardshorturl || "");
}
function rendertextsegments(raw, urlmap, hasmedia, hideshorturl) {
    const tokens = [];
    let last = 0;
    const re = /https?:\/\/\S+/g;
    let m;
    while ((m = re.exec(raw))) {
        if (m.index > last) tokens.push({k: "text", v: raw.slice(last, m.index)});
        tokens.push({k: "url", v: m[0]});
        last = m.index + m[0].length;
    }
    if (last < raw.length) tokens.push({k: "text", v: raw.slice(last)});
    let lasturlidx = -1;
    for (let i = 0; i < tokens.length; i++) if (tokens[i].k === "url") lasturlidx = i;

    let out = "";
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.k === "url") {
            const url = tok.v;
            const istco = /^https?:\/\/t\.co\//i.test(url);
            const istrailing = (i === lasturlidx);
            if (istco) {
                const expanded = urlmap && urlmap.get(url);
                if (expanded) {
                    if (istrailing && hideshorturl && url === hideshorturl) continue;
                    const pretty = expanded.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
                    const trunc = pretty.length > 32 ? pretty.slice(0, 32) + "..." : pretty;
                    out += '<a href="' + escapeattr(expanded) + '" target="_blank" rel="noopener">' + escapehtml(trunc) + '</a>';
                } else if (hasmedia && istrailing) {} else {
                    out += '<a class="unresolvedtco" data-tco="' + escapeattr(url) + '" href="' + escapeattr(url) + '" target="_blank" rel="noopener">(loading...)</a>';
                }
            } else {
                out += '<a href="' + escapeattr(url) + '" target="_blank" rel="noopener">' + escapehtml(url) + '</a>';
            }
        } else {
            let s = escapehtml(replacetofu(tok.v));
            s = s.replace(/(^|[^\w@])@([A-Za-z0-9_]+)/g, (full, pre, h) =>
                pre + '<a href="https://x.com/' + h + '" target="_blank" rel="noopener">@' + h + '</a>');
            s = s.replace(/(^|\s)#([A-Za-z0-9_]+)/g, (full, pre, h) =>
                pre + '<a href="https://x.com/hashtag/' + h + '" target="_blank" rel="noopener">#' + h + '</a>');
            out += s.replace(/\n/g, "<br>");
        }
    }
    return out.replace(/(\s|<br>)+$/, "");
}

/*//////////////////////////////////////////////////////////////////////*/

function escapehtml(s) {
    return String(s || "").replace(/[&<>"']/g, c =>
        ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
}
function escapeattr(s) { return escapehtml(s); }

// decode html entities back to proper symbols
const decoder = document.createElement("textarea");
function decodeentities(s) {
    if (s == null) return "";
    decoder.innerHTML = String(s);
    return decoder.value;
}
function decodeandescape(s) { return escapehtml(replacetofu(decodeentities(s))); }

/*//////////////////////////////////////////////////////////////////////*/

// tofu (x box) detector that doesn't even work right now
const tofucanvas = document.createElement("canvas");
const tofuctx = tofucanvas.getContext("2d");
tofuctx.font = '15px "Chirp", -apple-system, "Segoe UI", "Helvetica Neue", sans-serif';
let tofuwidth = null;
function gettofuwidth() {
    if (tofuwidth == null) tofuwidth = tofuctx.measureText("").width;
    return tofuwidth;
}
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { tofuwidth = null; tofucache.clear(); });
}
const tofucache = new Map();
function istofu(ch) {
    if (tofucache.has(ch)) return tofucache.get(ch);
    const code = ch.codePointAt(0);
    if (code < 0x100) { tofucache.set(ch, false); return false; }
    const tofu = tofuctx.measureText(ch).width === gettofuwidth();
    tofucache.set(ch, tofu);
    return tofu;
}
function replacetofu(text) {
    if (!text) return text;
    if (!/[^\x00-\xFF]/.test(text)) return text;
    let out = "";
    for (const ch of String(text)) {
        out += istofu(ch) ? " " : ch;
    }
    return out;
}

function imgwithname(url, name) {
    if (!url) return "";
    if (!/pbs\.twimg\.com\/(media|ext_tw_video_thumb|tweet_video_thumb|amplify_video_thumb|card_img)/.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "name=" + name;
}
function smallimg(url) { return imgwithname(url, "small"); }
function origimg(url)  { return imgwithname(url, "orig"); }

function usereleases() {
    const m = CFG.media;
    return !!(m && m.owner && m.repo);
}
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}
function mediaurl(p) {
    if (!p || p.startsWith("http") || !usereleases()) return p || "";
    const parts = p.split("/");
    if (parts.length < 3) return p;
    const handle = parts[0], cat = parts[parts.length - 2], file = parts[parts.length - 1];
    const shards = state.community && state.community.media_shards && state.community.media_shards[cat];
    let tag = "media-" + handle + "-" + cat;
    if (shards && shards > 1) tag += "-" + (fnv1a(file) % shards + 1);
    return "https://github.com/" + CFG.media.owner + "/" + CFG.media.repo + "/releases/download/" + tag + "/" + file;
}

function emojify(el) {
    if (el && window.twemoji) {
        twemoji.parse(el, {
            base: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/",
            folder: "svg", ext: ".svg",
        });
    }
}

// the permalink
function tweeturlfor(t) {
    const u = state.userbyid.get(t.user_id) || t.syndicateduser || {};
    return u.username
        ? "https://x.com/" + encodeURIComponent(u.username) + "/status/" + t.id
        : "https://x.com/i/status/" + t.id;
}

/*//////////////////////////////////////////////////////////////////////*/

function onmediaclick(e) {
    const el = e.currentTarget;
    e.preventDefault();
    const type = el.getAttribute("data-type") || "photo";
    const orig = el.getAttribute("data-orig") || "";
    const video = el.getAttribute("data-video") || "";
    openoverlay({type, orig, video});
}

function openoverlay({type, orig, video}) {
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    let inner;
    if ((type === "video" || type === "animated_gif") && video) {
        inner = '<video class="overlay-media" src="' + escapeattr(video) + '" controls autoplay playsinline'
            + (type === "animated_gif" ? ' loop muted' : '')
            + '></video>';
    } else {
        inner = '<img class="overlay-media" src="' + escapeattr(orig) + '" referrerpolicy="no-referrer">';
    }
    wrap.innerHTML = inner + '<button class="overlay-close" aria-label="close">&times;</button>';
    wrap.addEventListener("click", (ev) => {
        if (ev.target === wrap || ev.target.classList.contains("overlay-close")) {
            wrap.remove();
            document.body.style.overflow = "";
        }
    });
    document.addEventListener("keydown", function onkey(ev) {
        if (ev.key === "Escape") { wrap.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onkey) }
    });
    document.body.style.overflow = "hidden";
    document.body.appendChild(wrap);
}

function parsedate(s) {
    if (!s) return 0;
    const d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function fmtdate(s) {
    const t = parsedate(s);
    if (!t) return s || "";
    const d = new Date(t);
    const now = Date.now();
    const diff = (now - t) / 1000;
    if (diff < 60)     return Math.floor(diff) + "s";
    if (diff < 3600)   return Math.floor(diff/60) + "m";
    if (diff < 86400)  return Math.floor(diff/3600) + "h";
    if (diff < 86400*7) return Math.floor(diff/86400) + "d";
    const y = d.getFullYear() === new Date(now).getFullYear() ? "" : (", " + d.getFullYear());
    return d.toLocaleDateString(undefined, {month: "short", day: "numeric"}) + y;
}

function fmtjoined(s) {
    const t = parsedate(s);
    if (!t) return s || "";
    return new Date(t).toLocaleDateString(undefined, {month: "long", year: "numeric"});
}

function fmtnum(n) {
    return (n || 0).toLocaleString("en-US");
}

function fmtcountshort(n) {
    n = +n || 0;
    if (n < 1000) return String(n);
    if (n < 10000) return (n/1000).toFixed(1).replace(".0","") + "K";
    if (n < 1000000) return Math.round(n/1000) + "K";
    return (n/1000000).toFixed(1).replace(".0","") + "M";
}

function fmtbytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
    return (n/1024/1024).toFixed(2) + " MB";
}

/*//////////////////////////////////////////////////////////////////////*/

const corsproxy = "https://cors.estrogen.delivery/?url=";

function syndtoken(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}
const syndfeatures = "tfw_timeline_list:;tfw_tweet_edit_backend:on;tfw_refsrc_session:on;tfw_fosnr_soft_interventions_enabled:on;tfw_mixed_media_15897:treatment;tfw_experiments_cookie_expiration:1209600;tfw_show_birdwatch_pivots_enabled:on;tfw_duplicate_scribes_to_settings:on;tfw_use_profile_image_shape_enabled:on;tfw_video_hls_dynamic_manifests_15082:true_bitrate;tfw_tweet_edit_frontend:on";

function syndicationurl(id) {
    const inner = "https://cdn.syndication.twimg.com/tweet-result?id=" + encodeURIComponent(id)
        + "&lang=en&token=" + encodeURIComponent(syndtoken(id))
        + "&features=" + encodeURIComponent(syndfeatures);
    return corsproxy + encodeURIComponent(inner);
}

async function fetchsyndicatedtweet(id) {
    if (state.quotecache.has(id)) return state.quotecache.get(id);
    const local = state.byid.get(id);
    if (local) { state.quotecache.set(id, local); return local; }
    if (state.quotefetching && state.quotefetching.has(id)) {
        return state.quotefetching.get(id);
    }
    if (!state.quotefetching) state.quotefetching = new Map();
    const p = (async () => {
        try {
            const r = await fetch(syndicationurl(id));
            if (!r.ok) { state.quotecache.set(id, null); return null; }
            const j = await r.json();
            const payload = (j && j.data && j.data.id_str) ? j.data : j;
            const t = convertsyndicationtweet(payload);
            state.quotecache.set(id, t);
            return t;
        } catch (e) {
            console.warn("syndication fetch failed for " + id + ":", e);
            state.quotecache.set(id, null);
            return null;
        } finally {
            state.quotefetching.delete(id);
        }
    })();
    state.quotefetching.set(id, p);
    return p;
}

function convertsyndicationtweet(s) {
    if (!s || !s.id_str) return null;
    const su = s.user || {};
    const media = (s.mediaDetails || []).map(m => {
        const out = {type: m.type || "photo", thumbnail: m.media_url_https};
        const variants = m.video_info && m.video_info.variants || [];
        const mp4 = variants.filter(v => v.content_type === "video/mp4")
                                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (mp4) out.video_url = mp4.url;
        const dur = m.video_info && m.video_info.duration_millis;
        if (dur) out.duration_ms = dur;
        return out;
    });
    const urls = ((s.entities && s.entities.urls) || []).map(u => ({
        short: u.url, expanded: u.expanded_url || u.url,
    }));
    const t = {
        id: s.id_str,
        user_id: su.id_str || "",
        created_at: s.created_at,
        text: s.text || "",
        likes: s.favorite_count || 0,
        retweets: s.conversation_count || s.retweet_count || 0,
        replies: s.reply_count || 0,
        quotes: s.quote_count || 0,
        bookmarks: 0, views: 0,
        lang: s.lang || "",
        media: media, urls: urls,
        syndicated: true,
        syndicateduser: {
            id: su.id_str || "",
            username: su.screen_name || "",
            display_name: su.name || "",
            avatar: su.profile_image_url_https || "",
            verified: !!su.verified || !!su.is_blue_verified,
        },
    };
    if (s.in_reply_to_status_id_str) {
        t.in_reply_to = {
            status_id: s.in_reply_to_status_id_str,
            screen_name: s.in_reply_to_screen_name || "",
            user_id: s.in_reply_to_user_id_str || "",
        };
    }
    if (s.quoted_tweet && s.quoted_tweet.id_str) {
        t.quoted_id = s.quoted_tweet.id_str;

        state.quotecache.set(t.quoted_id, convertsyndicationtweet(s.quoted_tweet));
    }
    return t;
}

/*//////////////////////////////////////////////////////////////////////*/

state.detailopen = null;
state.feedscrolly = 0;

async function opentweetdetail(tweetid, opts) {

    if (!tweetid) return;
    const pushhistory = !opts || opts.push !== false;
    if (state.detailopen === tweetid) return;
    if (!state.detailopen) state.feedscrolly = window.scrollY || document.documentElement.scrollTop || 0;

    state.detailopen = tweetid;
    viewlist.hidden = true;
    viewdetail.hidden = false;
    detailbodyel.innerHTML = '<div class="detail"><div class="placeholder">loading...</div></div>';
    window.scrollTo(0, 0);

    if (pushhistory) {
        const url = new URL(location.href);
        url.searchParams.set("tweet", tweetid);
        history.pushState({tweet: tweetid}, "", url);
    }

    let focal = state.byid.get(tweetid);
    if (!focal) focal = await fetchsyndicatedtweet(tweetid);
    if (state.detailopen !== tweetid) return;
    if (!focal) {
        detailbodyel.innerHTML =
            '<div class="detail"><div class="placeholder">could not load tweet ' + escapehtml(tweetid) + '</div></div>';
        return;
    }

  if (focal.syndicated) {
        window.open(tweeturlfor(focal), "_blank", "noopener");
        closetweetdetail({pophistory: pushhistory});
        return;
    }

    const detailroot = document.createElement("div");
    detailroot.className = "detail";
    detailbodyel.innerHTML = "";
    detailbodyel.appendChild(detailroot);
    renderdetail(detailroot, focal);
}

function closetweetdetail(opts) {
    const pophistory = !opts || opts.pophistory !== false;
    if (!state.detailopen) return;
    state.detailopen = null;
    viewdetail.hidden = true;
    viewlist.hidden = false;
    detailbodyel.innerHTML = "";
    document.title = state.community ? (state.community.name + " - " + CFG.titlesuffix) : CFG.titlesuffix;
    const y = state.feedscrolly;
    if (pophistory) history.back();
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
}

detailbackbtn.addEventListener("click", () => closetweetdetail());
window.addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search);
    const tweetparam = p.get("tweet");
    if (tweetparam && state.detailopen !== tweetparam) {
        opentweetdetail(tweetparam, {push: false});
    } else if (!tweetparam && state.detailopen) {
        closetweetdetail({pophistory: false});
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.detailopen) closetweetdetail();
});

function collectauthorthread(t, authorid, acc, seen) {
    const kids = (state.repliesbyparent.get(t.id) || []).slice()
        .sort((a, b) => parsedate(a.created_at) - parsedate(b.created_at));
    for (const k of kids) {
        if (seen.has(k.id)) continue;
        if (k.user_id === authorid) {
            seen.add(k.id);
            acc.push({tweet: k, threaded: true});
        }
        collectauthorthread(k, authorid, acc, seen);
    }
}

/*//////////////////////////////////////////////////////////////////////*/

async function renderdetail(root, focal) {
    const ancestors = [];
    let cursor = focal;
    for (let depth = 0; depth < 8; depth++) {
        const ir = cursor.in_reply_to;
        if (!ir || !ir.status_id) break;
        const parent = state.byid.get(ir.status_id) || await fetchsyndicatedtweet(ir.status_id);
        if (!parent) break;
        ancestors.unshift(parent);
        cursor = parent;
    }
    let focalquoted = null;
    if (focal.quoted_id) {
        focalquoted = state.byid.get(focal.quoted_id) || state.quotecache.get(focal.quoted_id);
        if (!focalquoted) focalquoted = await fetchsyndicatedtweet(focal.quoted_id);
    }
    const children = (state.repliesbyparent.get(focal.id) || []).slice()
        .sort((a, b) => parsedate(a.created_at) - parsedate(b.created_at));
    root.innerHTML = "";

    if (ancestors.length) {
        const wrap = document.createElement("div");
        wrap.className = "ancestors";
        ancestors.forEach((p, idx) => {
            const card = rendertweet(p);
            card.classList.add("linedown");
            if (idx > 0) card.classList.add("lineup");
            wrap.appendChild(card);
        });
        root.appendChild(wrap);
    }

    root.insertAdjacentHTML("beforeend", renderfocalhtml(focal, focalquoted));
    const focalel = root.querySelector(".focal");
    if (ancestors.length) focalel.classList.add("lineup");
    wirefocal(focalel, focal);
    emojify(focalel);

    const replyentries = [];
    const seenthread = new Set();
    for (const c of children) {
        const isauthorcontinuation = c.user_id === focal.user_id;
        replyentries.push({tweet: c, threaded: isauthorcontinuation});
        seenthread.add(c.id);
        collectauthorthread(c, focal.user_id, replyentries, seenthread);
    }
    if (replyentries.length) {
        const wrap = document.createElement("div");
        wrap.className = "replies";
        for (let i = 0; i < replyentries.length; i++) {
            const {tweet, threaded} = replyentries[i];
            const card = rendertweet(tweet);
            if (threaded) {
                card.classList.add("threadcontinued", "lineup");
            }
            const next = replyentries[i + 1];
            const nextir = next && next.tweet.in_reply_to;
            if (next && next.threaded && nextir && nextir.status_id === tweet.id) {
                card.classList.add("linedown");
            }
            wrap.appendChild(card);
        }
        root.appendChild(wrap);
    }
    const missing = Math.max(0, (focal.replies || 0) - children.length);
    if (missing > 0) {
        root.insertAdjacentHTML("beforeend",
            '<div class="repliesfoot">' + fmtnum(missing) + ' more replies not in the archive</div>');
    }
    observelazyin(root);

    if (focalel && focalel.scrollIntoView) {
        focalel.scrollIntoView({block: "start"});
    }
}

function wirefocal(focalel, focal) {
    const viewsaction = focalel.querySelector(".actions .action.views");
    if (viewsaction) viewsaction.remove();
    for (const m of focalel.querySelectorAll(".mediaitem")) {
        if (!m.classList.contains("video")) m.addEventListener("click", onmediaclick);
    }
    const fq = focalel.querySelector(".quoted");
    if (fq && focal.quoted_id) {
        fq.addEventListener("click", (e) => {
            e.stopPropagation();
            opentweetdetail(focal.quoted_id);
        });
    }
    for (const m of focalel.querySelectorAll(".mediagrid.n1 .mediaitem img, .mediagrid.n1 .mediaitem video")) {
        wiren1aspect(m);
    }
    hydrateunresolvedtco(focalel);
}

function renderfocalhtml(t, quoted) {
    const u = state.userbyid.get(t.user_id) || t.syndicateduser || {};
    const avatarhtml = u.avatar
        ? '<img class="avatar" src="' + escapeattr(mediaurl(u.avatar)) + '" referrerpolicy="no-referrer" onerror="window.onavatarerror(this)">'
        : '<div class="avatar"></div>';
    const dname = decodeandescape(u.display_name || u.username || "(unknown)");
    const handle = u.username ? "@" + u.username : "@" + (t.user_id || "?");
    const verifiedhtml = u.verified ? iconverified : "";
    const syndhtml = t.syndicated ? '<span class="syndtag">(not from the dataset)</span>' : "";
    const tweeturl = tweeturlfor(t);

    const {remainder} = stripleadingmentions(t);
    const linkcardurl = picklinkcardurl(t);
    const ftext = formattweettext({...t, text: remainder}, linkcardurl);
    const mediahtml = rendermedia(t.media);
    const linkcardhtml = renderlinkcard(t);

    let quotedhtml = "";
    if (t.quoted_id) {
        quotedhtml = quoted
            ? renderquotedcard(quoted)
            : '<div class="quoted" data-quote-id="' + escapeattr(t.quoted_id) + '">' +
                '<div class="qheader"><div class="qavatar"></div><b>quoted tweet</b><span class="qhandle">id ' + escapehtml(t.quoted_id) + '</span></div>' +
                '<div class="qtext">loading!</div>' +
                '</div>';
    }

    const stamppieces = [
        '<a href="' + escapeattr(tweeturl) + '" target="_blank" rel="noopener">' + fmtfulldatetime(t.created_at) + '</a>',
    ];
    if (t.views) stamppieces.push('<b>' + fmtnum(t.views) + '</b> Views');
    const stamphtml = '<div class="stamp">' + stamppieces.join(" &middot; ") + '</div>';

    return '<div class="focal">' +
        '<div class="top">' + avatarhtml +
        '<div class="meta">' +
        '<span class="dnamerow">' +
            '<span class="dname">' + dname + '</span>' +
            verifiedhtml +
        '</span>' +
        '<span class="handle">' + escapehtml(handle) + '</span> ' +
        syndhtml +
        '</div></div>' +
        '<div class="ftext">' + ftext + '</div>' +
        mediahtml + linkcardhtml + quotedhtml +
        stamphtml +
        renderactions(t) +
        '</div>';
}

/*//////////////////////////////////////////////////////////////////////*/

function fmtfulldatetime(s) {
    const tms = parsedate(s);
    if (!tms) return s || "";
    const d = new Date(tms);
    const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
    const date = d.toLocaleDateString(undefined, {month: "long", day: "numeric", year: "numeric"});
    return time + " &middot; " + date;
}
