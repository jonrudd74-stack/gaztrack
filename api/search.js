export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, liquidator, from, to, pageSize = 50 } = req.query;

  // Build search query
  let q = 'appointment of liquidator';
  if (company) q += ' ' + company;
  if (liquidator) q += ' ' + liquidator;

  // category-code=I2 = Insolvency notices only
  // notice-type=2120 = Appointment of Liquidator specifically
  const params = new URLSearchParams({
    'results-page-size': pageSize,
    'category-code': 'I2',
    'notice-type': '2120',
    'start-publish-date': from,
    'end-publish-date': to,
    'q': q,
    'format': 'application/json'
  });

  try {
    const url = `https://www.thegazette.co.uk/all-notices/notice?${params}`;
    console.log('Fetching:', url);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; InsolvencyTracker/1.0)'
      }
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Gazette API error', detail: text.substring(0, 300) });
    }

    let data;
    try { data = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Could not parse response', detail: text.substring(0, 300) }); }

    const notices = data['entry'] || [];
    const total = data['f:total'] || notices.length;

    const parsed = notices.map(n => {
      const rawHtml = n['summary'] || n['content'] || n['f:body'] || '';
      const plain = stripHtml(rawHtml);
      const title = typeof n['title'] === 'string' ? n['title'] : (n['title']?.['#text'] || '');
      const combined = (plain + ' ' + title).trim();

      const noticeUrl = typeof n['id'] === 'string' && n['id'].startsWith('http')
        ? n['id']
        : 'https://www.thegazette.co.uk/notice/' + (n['id'] || '');

      return {
        id: String(n['id'] || '').split('/').pop(),
        company: n['f:company-name'] || extractCompany(combined, title) || '—',
        liquidator: n['f:person-name'] || extractLiquidator(combined) || '—',
        firm: n['f:organisation-name'] || extractFirm(combined) || '—',
        date: (n['published'] || n['updated'] || '').substring(0, 10),
        url: noticeUrl,
        raw: combined.substring(0, 500)
      };
    });

    res.status(200).json({ total, notices: parsed,
      debug: { url, status: response.status, entryCount: notices.length, sampleKeys: notices[0] ? Object.keys(notices[0]) : [] }
    });

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractCompany(text, title) {
  // Try title first — often "Company Name - Appointment of Liquidator"
  if (title) {
    const t = title.replace(/[-–—].*$/, '').trim();
    if (t.match(/Ltd|Limited|LLP|PLC|plc/i)) return t;
  }
  const patterns = [
    /(?:in the matter of|re:?)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/i,
    /([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)\s+(?:–|-|—)/,
    /^([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/m
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractLiquidator(text) {
  const patterns = [
    /(?:joint\s+)?liquidator[s]?[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i,
    /I[,\s]+([A-Z][A-Z\s]+(?:[A-Z][a-z]+\s?)+)[,\s]+of\s+/,
    /appointed[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractFirm(text) {
  const patterns = [
    /(?:of|at)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|LLC|Ltd|Limited|Partners|Group|Associates|Advisory|Restructuring|Insolvency|Recovery|Solutions))/,
    /(?:firm|practice)[:\s]+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|Ltd|Limited|Partners|Group))/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}
