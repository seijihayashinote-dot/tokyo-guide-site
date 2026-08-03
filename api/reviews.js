// Serverless function: stores and returns guest reviews using Vercel KV
// (Upstash Redis under the hood). Reads KV_REST_API_URL / KV_REST_API_TOKEN,
// which Vercel injects automatically once a KV database is connected to
// this project under the "Storage" tab.

async function kv(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('KV not configured — connect a Vercel KV database to this project.');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error('KV request failed: ' + res.status);
  }
  return res.json();
}

function clean(str, max) {
  return String(str || '').trim().slice(0, max);
}

// Minimal NG-word / spam filter. Blocks obvious spam content (links, common
// spam-ad keywords, HTML injection attempts). Not exhaustive — just a
// first line of defense against bots and low-effort spam.
const NG_WORDS = [
  'http://', 'https://', 'www.', '<script', '[url=', '.ru/', 'bit.ly',
  'viagra', 'cialis', 'casino', 'crypto', 'bitcoin', 'forex', 'loan',
  'porn', 'xxx', 'nude', 'sex ', 'escort',
];

function containsNgWord(text) {
  const lower = text.toLowerCase();
  return NG_WORDS.some((w) => lower.includes(w));
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

// Simple hash so we don't store raw IPs in KV.
function hashIp(ip) {
  let h = 0;
  for (let i = 0; i < ip.length; i++) {
    h = (h * 31 + ip.charCodeAt(i)) | 0;
  }
  return 'ip' + Math.abs(h).toString(36);
}

function isAdmin(req) {
  const token = req.headers['x-admin-token'] || (req.query && req.query.token);
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const result = await kv(['LRANGE', 'reviews', '0', '499']);
      const reviews = (result.result || [])
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ reviews });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const name = clean(body.name, 60);
      const country = clean(body.country, 60);
      const ageGroup = clean(body.ageGroup, 20);
      const groupSize = Math.max(1, Math.min(20, parseInt(body.groupSize, 10) || 0));
      const text = clean(body.text, 800);
      let rating = parseInt(body.rating, 10);
      if (!Number.isFinite(rating)) rating = 0;
      rating = Math.max(1, Math.min(5, rating));

      if (!name || !country || !ageGroup || !groupSize || !text || !body.rating) {
        return res.status(400).json({ error: 'Missing a required field.' });
      }

      if (containsNgWord(`${name} ${country} ${text}`)) {
        return res.status(400).json({ error: 'Your review could not be posted. Please remove links or inappropriate content.' });
      }

      // Rate-limit: same visitor (by IP) can only post once every 3 minutes,
      // and at most 5 reviews per rolling 24h window.
      const ipKey = hashIp(getClientIp(req));
      const cooldownKey = `review_cd:${ipKey}`;
      const dayKey = `review_day:${ipKey}`;

      const cooldown = await kv(['GET', cooldownKey]);
      if (cooldown.result) {
        return res.status(429).json({ error: 'Please wait a few minutes before submitting another review.' });
      }

      const dayCount = await kv(['INCR', dayKey]);
      if (dayCount.result === 1) {
        await kv(['EXPIRE', dayKey, '86400']);
      }
      if (dayCount.result > 5) {
        return res.status(429).json({ error: 'You have reached the daily review limit.' });
      }

      const review = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name,
        country,
        ageGroup,
        groupSize,
        rating,
        text,
        date: new Date().toISOString(),
      };

      await kv(['LPUSH', 'reviews', JSON.stringify(review)]);
      await kv(['LTRIM', 'reviews', '0', '499']); // keep the list bounded
      await kv(['SET', cooldownKey, '1', 'EX', '180']); // 3 min cooldown

      return res.status(200).json({ ok: true, review });
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const id = (req.query && req.query.id) || body.id;
      if (!id) {
        return res.status(400).json({ error: 'Missing review id.' });
      }

      const result = await kv(['LRANGE', 'reviews', '0', '499']);
      const raw = result.result || [];
      const parsed = raw
        .map((s) => {
          try {
            return { raw: s, review: JSON.parse(s) };
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);

      const remaining = parsed.filter((item) => item.review.id !== id);
      if (remaining.length === parsed.length) {
        return res.status(404).json({ error: 'Review not found.' });
      }

      await kv(['DEL', 'reviews']);
      for (const item of remaining) {
        await kv(['RPUSH', 'reviews', item.raw]);
      }

      return res.status(200).json({ ok: true, deletedId: id });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
