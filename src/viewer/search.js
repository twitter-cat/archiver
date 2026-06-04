"use strict";

const FILTERS = new Set([
    "media", "images", "image", "photos", "twimg",
    "videos", "video", "native_video", "gif", "gifs",
    "links", "replies", "reply", "quote", "quotes",
    "verified", "blue_verified",
]);

function tokenize(q) {
    const tokens = [];
    const re = /(-?)(?:([a-z_]+):)?"([^"]*)"|(\S+)/gi;
    let m;
    while ((m = re.exec(q))) {
        if (m[3] !== undefined) {
            tokens.push({neg: m[1] === "-", op: (m[2] || "").toLowerCase(), value: m[3], quoted: true});
        } else {
            let raw = m[4];
            let neg = false;
            if (raw[0] === "-") { neg = true; raw = raw.slice(1); }
            const c = raw.indexOf(":");
            if (c > 0 && /^[a-z_]+$/i.test(raw.slice(0, c))) {
                tokens.push({neg, op: raw.slice(0, c).toLowerCase(), value: raw.slice(c + 1), quoted: false});
            } else {
                tokens.push({neg, op: "", value: raw, quoted: false});
            }
        }
    }
    return tokens;
}

function parsedatestamp(v) {
    if (!v) return null;
    const ts = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v);
    return Number.isNaN(ts) ? null : ts;
}

function tweettime(t) {
    const ts = Date.parse(t.created_at);
    return Number.isNaN(ts) ? 0 : ts;
}

function emptytweetquery() {
    return {
        terms: [], phrases: [], notterms: [], notphrases: [],
        from: [], to: [], mentions: [], hashtags: [], urlcontains: [],
        lang: null, since: null, until: null,
        minfaves: null, minretweets: null, minreplies: null, minquotes: null, minviews: null,
        filters: new Set(), notfilters: new Set(),
    };
}

export function parsetweetquery(q) {
    const sp = emptytweetquery();
    for (const tok of tokenize(q || "")) {
        const v = tok.value;
        const lv = v.toLowerCase();
        switch (tok.op) {
            case "from": sp.from.push(lv.replace(/^@/, "")); break;
            case "to": sp.to.push(lv.replace(/^@/, "")); break;
            case "lang": sp.lang = lv; break;
            case "url": sp.urlcontains.push(lv); break;
            case "since": case "since_date": { const d = parsedatestamp(v); if (d != null) sp.since = d; break; }
            case "until": case "before": { const d = parsedatestamp(v); if (d != null) sp.until = d; break; }
            case "min_faves": case "min_likes": sp.minfaves = +v || 0; break;
            case "min_retweets": sp.minretweets = +v || 0; break;
            case "min_replies": sp.minreplies = +v || 0; break;
            case "min_quotes": sp.minquotes = +v || 0; break;
            case "min_views": sp.minviews = +v || 0; break;
            case "filter": {
                if (FILTERS.has(lv)) (tok.neg ? sp.notfilters : sp.filters).add(lv);
                break;
            }
            case "": {
                if (v[0] === "@" && v.length > 1) { sp.mentions.push(lv.slice(1)); break; }
                if (v[0] === "#" && v.length > 1) { sp.hashtags.push(lv.slice(1)); break; }
                if (tok.quoted) (tok.neg ? sp.notphrases : sp.phrases).push(lv);
                else (tok.neg ? sp.notterms : sp.terms).push(lv);
                break;
            }
            default:
                (tok.neg ? sp.notterms : sp.terms).push(lv);
        }
    }
    return sp;
}

function tweethaystack(t, ctx) {
    const u = ctx && ctx.userbyid && ctx.userbyid.get(t.user_id);
    const quoted = t.quoted_id && ctx && ctx.byid && ctx.byid.get(t.quoted_id);
    const parts = [t.text || ""];
    if (u) { parts.push(u.username || "", u.display_name || ""); }
    for (const url of t.urls || []) parts.push(url.expanded || "");
    if (quoted) parts.push(quoted.text || "");
    return parts.join("\n").toLowerCase();
}

function passesfilter(t, name, ctx) {
    const media = t.media || [];
    switch (name) {
        case "media": case "twimg": return media.length > 0;
        case "images": case "image": case "photos": return media.some(m => m.type === "photo");
        case "videos": case "video": case "native_video": return media.some(m => m.type === "video");
        case "gif": case "gifs": return media.some(m => m.type === "animated_gif");
        case "links": return (t.urls || []).length > 0;
        case "replies": case "reply": return !!(t.in_reply_to && t.in_reply_to.status_id);
        case "quote": case "quotes": return !!t.quoted_id;
        case "verified": case "blue_verified": {
            const u = ctx && ctx.userbyid && ctx.userbyid.get(t.user_id);
            return !!(u && u.verified);
        }
        default: return true;
    }
}

export function matchtweet(t, sp, ctx) {
    const hay = tweethaystack(t, ctx);
    for (const term of sp.terms) if (!hay.includes(term)) return false;
    for (const term of sp.notterms) if (hay.includes(term)) return false;
    for (const ph of sp.phrases) if (!hay.includes(ph)) return false;
    for (const ph of sp.notphrases) if (hay.includes(ph)) return false;

    if (sp.from.length) {
        const u = ctx && ctx.userbyid && ctx.userbyid.get(t.user_id);
        const handle = (u && u.username || "").toLowerCase();
        if (!sp.from.includes(handle)) return false;
    }
    if (sp.to.length) {
        const target = (t.in_reply_to && t.in_reply_to.screen_name || "").toLowerCase();
        if (!sp.to.includes(target)) return false;
    }
    if (sp.mentions.length) {
        const ms = new Set((t.mentions || []).map(m => m.toLowerCase()));
        for (const want of sp.mentions) if (!ms.has(want)) return false;
    }
    if (sp.hashtags.length) {
        const text = (t.text || "").toLowerCase();
        for (const tag of sp.hashtags) if (!text.includes("#" + tag)) return false;
    }
    if (sp.urlcontains.length) {
        const urls = (t.urls || []).map(u => (u.expanded || "").toLowerCase());
        for (const want of sp.urlcontains) if (!urls.some(u => u.includes(want))) return false;
    }
    if (sp.lang && (t.lang || "").toLowerCase() !== sp.lang) return false;

    if (sp.since != null || sp.until != null) {
        const tt = tweettime(t);
        if (sp.since != null && tt < sp.since) return false;
        if (sp.until != null && tt >= sp.until) return false;
    }

    if (sp.minfaves != null && (t.likes || 0) < sp.minfaves) return false;
    if (sp.minretweets != null && (t.retweets || 0) < sp.minretweets) return false;
    if (sp.minreplies != null && (t.replies || 0) < sp.minreplies) return false;
    if (sp.minquotes != null && (t.quotes || 0) < sp.minquotes) return false;
    if (sp.minviews != null && (+t.views || 0) < sp.minviews) return false;

    for (const f of sp.filters) if (!passesfilter(t, f, ctx)) return false;
    for (const f of sp.notfilters) if (passesfilter(t, f, ctx)) return false;

    return true;
}

/*//////////////////////////////////////////////////////////////////////*/

export function parseuserquery(q) {
    const sp = {terms: [], notterms: [], minfollowers: null, verified: false};
    for (const tok of tokenize(q || "")) {
        const lv = tok.value.toLowerCase();
        if (tok.op === "min_followers") { sp.minfollowers = +tok.value || 0; continue; }
        if (tok.op === "filter" && (lv === "verified" || lv === "blue_verified")) { sp.verified = true; continue; }
        (tok.neg ? sp.notterms : sp.terms).push(lv);
    }
    return sp;
}

export function matchuser(u, sp) {
    const hay = [u.username || "", u.display_name || "", u.bio || "", u.location || ""].join("\n").toLowerCase();
    for (const term of sp.terms) if (!hay.includes(term)) return false;
    for (const term of sp.notterms) if (hay.includes(term)) return false;
    if (sp.minfollowers != null && (u.followers || 0) < sp.minfollowers) return false;
    if (sp.verified && !u.verified) return false;
    return true;
}
