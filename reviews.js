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

      return res.status(200).json({ ok: true, review });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
