const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const express = require('express');
const fs   = require('fs');
const path = require('path');

// ── API Server ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── CORS — erlaubt die Website (Vercel) auf die API zuzugreifen ─────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DATA_FILE     = path.join(__dirname, '..', 'tiers.json');
const VERIFIED_FILE = path.join(__dirname, '..', 'verified.json');
const API_KEY = 'silent-tiers-arox-2024'; // Change this to your own secret!

function loadTiers() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  return {};
}
function saveTiers(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// Verified users persistenz — lädt beim Start, speichert bei jeder Änderung
function loadVerified() {
  try { if (fs.existsSync(VERIFIED_FILE)) return new Map(Object.entries(JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8')))); } catch {}
  return new Map();
}
function saveVerified(map) {
  fs.writeFileSync(VERIFIED_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
}

const tierData = loadTiers();

function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/player/:ign — Mod reads this
app.get('/api/player/:ign', (req, res) => {
  const ign = req.params.ign.toLowerCase();
  const player = tierData[ign];
  if (!player) return res.json({ found: false, ign: req.params.ign });
  res.json({ found: true, ...player });
});

// GET /api/players — alle Spieler (Website Rankings)
app.get('/api/players', (req, res) => res.json(tierData));

// POST /api/player — Bot schreibt wenn /result benutzt wird
app.post('/api/player', requireAuth, (req, res) => {
  const { ign, tier, previousTier, tester, region, discordId } = req.body;
  if (!ign || !tier) return res.status(400).json({ error: 'Missing ign or tier' });
  const key = ign.toLowerCase();
  const TIER_ORDER = ['Unranked','LT5','HT5','LT4','HT4','LT3','HT3','LT2','HT2','LT1','HT1'];
  tierData[key] = {
    ign, tier,
    previousTier: previousTier || 'Unranked',
    peakTier: tierData[key]?.peakTier || tier,
    tester: tester || 'Unknown',
    region: region || 'EU',
    discordId: discordId || null,
    updatedAt: Date.now(),
    testedAt: Date.now(),
  };
  const currentPeakIdx = TIER_ORDER.indexOf(tierData[key].peakTier);
  const newTierIdx = TIER_ORDER.indexOf(tier);
  if (newTierIdx > currentPeakIdx) tierData[key].peakTier = tier;
  saveTiers(tierData);
  res.json({ success: true, player: tierData[key] });
});

// DELETE /api/player/:ign
app.delete('/api/player/:ign', requireAuth, (req, res) => {
  const key = req.params.ign.toLowerCase();
  if (!tierData[key]) return res.status(404).json({ error: 'Player not found' });
  delete tierData[key];
  saveTiers(tierData);
  res.json({ success: true });
});

// GET /api/verified — Discord ID → IGN mapping (Website Player Modal)
app.get('/api/verified', (req, res) => {
  const result = {};
  for (const [discordId, data] of client.verifiedUsers.entries()) {
    result[discordId] = typeof data === 'string' ? { ign: data } : data;
  }
  res.json(result);
});

// GET /api/staff — Staff mit Discord Online-Status (Website Staff Seite)
app.get('/api/staff', async (req, res) => {
  const ROLE_ORDER = [
    { name: 'Owner',            id: '1477845059230761000' },
    { name: 'Co-Owner',         id: '1477845186523435018' },
    { name: 'Dev',              id: '1487561185917145230' },
    { name: 'Heat Admin',       id: '1487560201476243466' },
    { name: 'Admin',            id: '1487560294220693724' },
    { name: 'Mod',              id: '1487560351405834322' },
    { name: 'Sr Helper',        id: '1487560346792099840' },
    { name: 'Helper',           id: '1485765614223098038' },
    { name: 'Voluntary Tester', id: '1477727896566108180' },
    { name: 'Senior Tester',    id: '1477727805205774468' },
    { name: 'Tester',           id: '1477727860947943655' },
  ];

  try {
    const guild = client.guilds.cache.first();
    if (!guild) return res.json([]);

    await guild.members.fetch();

    const seen = new Set();
    const staffList = [];

    for (const roleInfo of ROLE_ORDER) {
      const role = guild.roles.cache.get(roleInfo.id);
      if (!role) continue;

      for (const [, member] of role.members) {
        if (seen.has(member.id)) continue;
        seen.add(member.id);

        const presence = member.presence;
        const status = presence?.status || 'offline';
        const verified = client.verifiedUsers.get(member.id);
        const ign = verified?.ign || verified || null;

        staffList.push({
          id:       member.id,
          name:     member.displayName,
          username: member.user.username,
          avatar:   member.user.displayAvatarURL({ size: 64, format: 'png' }),
          role:     roleInfo.name,
          status,
          ign,
        });
      }
    }

    res.json(staffList);
  } catch (e) {
    console.error('Staff endpoint error:', e.message);
    res.json([]);
  }
});

// GET /api/testers — Tester Leaderboard (Website Testers Seite)
app.get('/api/testers', (req, res) => {
  // All-Time: zähle tester-Feld aus tiers.json
  const allTimeCounts = {};
  for (const player of Object.values(tierData)) {
    const tester = player.tester;
    if (tester && tester !== 'Unknown') {
      allTimeCounts[tester] = (allTimeCounts[tester] || 0) + 1;
    }
  }

  const allTime = Object.entries(allTimeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Monthly: nur Tests aus den letzten 30 Tagen
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const monthlyCounts = {};
  for (const player of Object.values(tierData)) {
    if (player.tester && player.tester !== 'Unknown' && player.testedAt && player.testedAt >= thirtyDaysAgo) {
      monthlyCounts[player.tester] = (monthlyCounts[player.tester] || 0) + 1;
    }
  }

  const monthly = Object.entries(monthlyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  res.json({ allTime, monthly });
});

// Health check
app.get('/', (req, res) => {
  res.json({ name: 'Silent Tiers API', players: Object.keys(tierData).length, status: 'online' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT} | ${Object.keys(tierData).length} players loaded`));

// Make tierData accessible to bot commands
global.tierData = tierData;
global.saveTiers = saveTiers;

// ── Discord Bot ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands        = new Collection();
client.queues          = new Map();
client.openQueues      = new Set();
client.activeTickets   = new Map();
client.cooldowns       = new Map();
client.verifiedUsers   = loadVerified(); // ← persistente verified users laden
client.activeTesters   = new Map();
client.lastSession     = new Map();
client.pendingAnnounce = new Map();

// Hilfsfunktion damit Commands verified users speichern können
global.saveVerified = () => saveVerified(client.verifiedUsers);

// Load commands
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(__dirname, 'commands', file));
  client.commands.set(cmd.data.name, cmd);
}

// Load events
for (const file of fs.readdirSync(path.join(__dirname, 'events')).filter(f => f.endsWith('.js'))) {
  const evt = require(path.join(__dirname, 'events', file));
  evt.once
    ? client.once(evt.name, (...a) => evt.execute(...a, client))
    : client.on(evt.name,   (...a) => evt.execute(...a, client));
}

// Crash protection
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message || err));
client.on('error', (err) => console.error('Client error:', err.message || err));

// ⚠️ PASTE YOUR BOT TOKEN BELOW — keep the quotes!
client.login('MTQ3NzczNDU5MTg4NzU3MzEwMw.GfNLos.u2MxV2lRRXT2uIK5X1WQLQifbIUq6xGCtSdU_8');
