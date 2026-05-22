# Publishing The Site

This folder is ready to publish as a static GitHub or Cloudflare Pages site.

## Site Files

- `index.html` is the homepage GitHub Pages expects.
- `games/mirror-beam/` is the playable game.
- `workers/mirror-beam-scores/` is the optional online scoreboard API.

## GitHub Pages

1. Put these files in your site repository.
2. In GitHub, open **Settings > Pages**.
3. Set the source to the main branch root.
4. Open `/games/mirror-beam/` on the published site.

## Cloudflare Pages

Use this repository as a static Pages project. No build command is required because the game output is already checked in.

## Online Scores

Scores work locally first. For a global leaderboard:

1. Deploy the Worker in `workers/mirror-beam-scores/`.
2. Create and bind a Cloudflare D1 database.
3. Run `schema.sql`.
4. Update `games/mirror-beam/config.js`:

```js
window.MIRROR_BEAM_SCORE_API = "https://your-worker.workers.dev";
```

Use `"same-origin"` instead if `/api/scores` is routed through the same domain.
