# tcat-archiver

simple cli that archives any twitter profile into a self-contained html viewer (by [cv](https://coolsite.cv)) using [emusks](https://emusks.tiago.zip).

captures tweets, replies, media (photos, videos, gifs), quote tweets, link embeds, and every referenced author's profile.

## install

```bash
bun install
```

## usage

```bash
bun run src/cli.js <handle...> [options]
```

archive a single profile:

```bash
bun run src/cli.js tommyinnit --token ... --zip
```

cycle several accounts (spreads rate limits):

```bash
ARCHIVER_TOKENS="AAA,BBB,CCC" bun run src/cli.js jack
```

### options

| flag | description |
| --- | --- |
| `--token <auth_token>` | an `auth_token` cookie value. repeatable for multiple accounts. |
| `--tokens-file <path>` | file with one `auth_token` per line (or comma/space separated). |
| `--out <dir>` | output directory. default: `<handle>-archive`. |
| `--zip` | also produce a `<out>.zip` alongside the folder. |
| `--client <name>` | emusks client to emulate (e.g. `tweetdeck`). default: `web`. |
| `--endpoint <name>` | graphql endpoint: `web` \| `main` \| `tweetdeck` \| ... |
| `--concurrency <n>` | parallel media downloads. default: `12`. |

tokens can also come from the `ARCHIVER_TOKENS` env var.

### finding your auth token

1. open [x.com](https://x.com) logged in
2. devtools > application > cookies > `https://x.com`
3. copy the value of `auth_token`

any account that hits a rate limit is cooled down while the others keep working.

## viewing your archive

the output is a ready-to-serve folder:

```
index.html  view.js  view.css  search.js  profiles.json
assets/fonts/…
<handle>/tweets.json  <handle>/users.json  <handle>/cards.json
<handle>/media/…  <handle>/pfps/…
```

browsers block `fetch` over `file://`, so serve it over http:

```bash
cd <handle>-archive && bunx serve
```

to share it, upload the folder to any static host (cloudflare pages, etc.). pass `--zip` to also get a single archive file.

## license

[AGPLv3.0](./LICENSE)

please ensure you have permission before archiving tweets from any user.

***

built by [twitter.cat](https://twitter.cat) · not affiliated with X Corp.
