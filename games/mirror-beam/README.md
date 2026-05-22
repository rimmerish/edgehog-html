# Mirror Beam

Static game page for the Edgehog Systems site.

## Run Locally

```sh
node scripts/serve-static.mjs
```

Then open `http://localhost:4173/`.

## Scores

Scores always work locally with `localStorage`. To enable online scores, deploy `../../workers/mirror-beam-scores`, then set `window.MIRROR_BEAM_SCORE_API` in `config.js`.

Use:

- `""` for local-only scores
- `"same-origin"` when `/api/scores` is routed on the same domain
- a full Worker URL for a standalone Cloudflare Worker

## Rebuild

After editing `src/App.jsx`, run:

```sh
node scripts/build-static.mjs
```
