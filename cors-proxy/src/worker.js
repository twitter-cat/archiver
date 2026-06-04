// a small permissive CORS proxy for the archive viewer. it fetches the target
// passed as ?url= and re-serves it with access-control-allow-origin:*, so the
// static viewer can resolve t.co links, read opengraph metadata, and hit the
// twitter syndication api from the browser.

const BLOCKED_HOST =
	/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|metadata\.|.*\.internal)$/i;

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,HEAD,OPTIONS",
	"access-control-allow-headers": "*",
	"access-control-expose-headers": "*",
	"access-control-max-age": "86400",
};

function reply(body, status) {
	return new Response(body, { status, headers: { ...CORS, "content-type": "text/plain" } });
}

export default {
	async fetch(request) {
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
		if (request.method !== "GET" && request.method !== "HEAD") return reply("method not allowed", 405);

		const target = new URL(request.url).searchParams.get("url");
		if (!target) return reply("usage: /?url=<encoded target url>", 400);

		let u;
		try {
			u = new URL(target);
		} catch {
			return reply("bad url", 400);
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") return reply("only http(s) is allowed", 400);
		if (BLOCKED_HOST.test(u.hostname)) return reply("blocked host", 403);

		let upstream;
		try {
			upstream = await fetch(u.toString(), {
				method: request.method,
				headers: {
					"user-agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
					accept: request.headers.get("accept") || "text/html,application/json,*/*",
					"accept-language": "en-US,en;q=0.9",
				},
				redirect: "follow",
				cf: { cacheTtl: 300, cacheEverything: false },
			});
		} catch (err) {
			return reply(`upstream fetch failed: ${err.message}`, 502);
		}

		const headers = new Headers(CORS);
		const ct = upstream.headers.get("content-type");
		if (ct) headers.set("content-type", ct);
		headers.set("x-proxy-url", u.toString());
		headers.set("x-proxy-status", String(upstream.status));
		return new Response(upstream.body, { status: upstream.status, headers });
	},
};
