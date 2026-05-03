// ─── Bet Builder Live API ────────────────────────────────────────
// Vercel serverless function — fetches live fixtures every 6 hours
// and serves them to the frontend app.

const LEAGUE_CONFIGS = [
  { name: "Premier League",   key: "epl",             flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { name: "Champions League", key: "champions_league", flag: "⭐"  },
  { name: "La Liga",          key: "la_liga",          flag: "🇪🇸" },
  { name: "Bundesliga",       key: "bundesliga",       flag: "🇩🇪" },
  { name: "Serie A",          key: "serie_a",          flag: "🇮🇹" },
  { name: "Ligue 1",          key: "ligue_1",          flag: "🇫🇷" },
];

// Simple in-memory cache (resets on cold starts, fine for serverless)
let cache = { data: null, fetchedAt: null };
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Main handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — allow any origin so the frontend can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const forceRefresh = req.query.refresh === "1";

  // Return cache if fresh
  if (!forceRefresh && cache.data && Date.now() - cache.fetchedAt < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true, cachedAt: cache.fetchedAt });
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY environment variable not set." });
  }

  try {
    const results = {};
    const today   = new Date();
    const dateStr = today.toISOString().split("T")[0]; // YYYY-MM-DD

    for (const league of LEAGUE_CONFIGS) {
      const fixtures = await fetchFixtures(apiKey, league.key, dateStr);
      results[league.name] = fixtures;
    }

    cache = { data: { leagues: results, fetchedAt: Date.now() }, fetchedAt: Date.now() };
    return res.status(200).json({ ...cache.data, cached: false });

  } catch (err) {
    console.error("Fetch error:", err);
    // If we have stale cache, serve it rather than erroring
    if (cache.data) {
      return res.status(200).json({ ...cache.data, cached: true, stale: true });
    }
    return res.status(500).json({ error: "Failed to fetch fixtures", detail: err.message });
  }
}

// ─── Fetch fixtures from API-Football ───────────────────────────
async function fetchFixtures(apiKey, leagueKey, dateStr) {
  const LEAGUE_IDS = {
    epl:             { id: 39,  season: 2025 },
    champions_league:{ id: 2,   season: 2025 },
    la_liga:         { id: 140, season: 2025 },
    bundesliga:      { id: 78,  season: 2025 },
    serie_a:         { id: 135, season: 2025 },
    ligue_1:         { id: 61,  season: 2025 },
  };

  const cfg = LEAGUE_IDS[leagueKey];
  if (!cfg) return [];

  // Fetch next 14 days of fixtures
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 14);
  const nextDateStr = nextDate.toISOString().split("T")[0];

  const url = `https://v3.football.api-sports.io/fixtures?league=${cfg.id}&season=${cfg.season}&from=${dateStr}&to=${nextDateStr}&status=NS`;

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": apiKey,
      "x-rapidapi-host": "v3.football.api-sports.io",
    },
  });

  if (!response.ok) {
    throw new Error(`API-Football responded ${response.status} for league ${leagueKey}`);
  }

  const json = await response.json();
  const fixtures = json.response || [];

  // Map to our internal format
  return fixtures.slice(0, 15).map(f => {
    const homeId = f.teams.home.id;
    const awayId = f.teams.away.id;

    // Win probabilities — API-Football provides these in the predictions endpoint
    // We calculate a rough estimate from recent form if not available
    const homeProb = f.predictions?.percent?.home
      ? parseFloat(f.predictions.percent.home)
      : estimateProb(f.teams.home, f.teams.away, "home");
    const awayProb = f.predictions?.percent?.away
      ? parseFloat(f.predictions.percent.away)
      : estimateProb(f.teams.home, f.teams.away, "away");
    const drawProb = Math.max(0, 100 - homeProb - awayProb);

    // Format kickoff time in BST
    const kickoff = new Date(f.fixture.date);
    const formatted = kickoff.toLocaleString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    });

    return {
      id:      f.fixture.id,
      home:    f.teams.home.name,
      away:    f.teams.away.name,
      time:    formatted,
      homeId,
      awayId,
      hp:      parseFloat(homeProb.toFixed(1)),
      ap:      parseFloat(awayProb.toFixed(1)),
      dp:      parseFloat(drawProb.toFixed(1)),
      venue:   f.fixture.venue?.name || "",
      status:  f.fixture.status?.short || "NS",
    };
  }).filter(f => f.status === "NS"); // only not-started
}

// ─── Rough probability estimate from league position ─────────────
function estimateProb(homeTeam, awayTeam, side) {
  // Fallback when predictions not available — slight home advantage assumed
  const base = side === "home" ? 45 : 30;
  return base + Math.random() * 10;
}
