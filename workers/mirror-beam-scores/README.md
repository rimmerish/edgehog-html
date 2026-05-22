# Mirror Beam Scores

Cloudflare Worker + D1 API for Mirror Beam leaderboards.

## Endpoints

- `GET /api/scores?map=0`
- `POST /api/scores` with `{ "map": 0, "seed": 12345, "initials": "AAA", "score": 42 }`

## Deploy

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create a D1 database named `mirror-beam-scores`.
3. Put the D1 database id in `wrangler.toml`.
4. Run the SQL in `schema.sql` against the D1 database.
5. Deploy the Worker.
6. Set `games/mirror-beam/config.js` to the Worker URL, or to `"same-origin"` if you route `/api/scores` through the same domain.
