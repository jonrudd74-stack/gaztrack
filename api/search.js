export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, liquidator, from, to, pageSize = 50 } = req.query;

  // Build a broader query — exact phrase plus optional terms
  let q = 'appointment of liquidator';
  if (company) q += ' ' + company;
  if (liquidator) q += ' ' + liquidator;

  const params = new URLSearchParams({
    'results-page-size': pageSize,
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
    console.log('Response status:', response.status);
    console.log('Response preview:', text.substring(0, 500));

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Gazette API error', detail: text.substring(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse Gazette response', detail: text.substring(0, 300) });
    }

    // The Gazette API can return notices under several keys
    const notices =
      data['_embedded']?.['gazette-notice'] ||
      data['_embedded']?.['notices'] ||
      data['notices'] ||
      data['results'] ||
      [];

    console.log('Notices found:', notices.length, 'Total:', data['total']);

    const parsed = notices.map(n => {
      const desc = n['description'] || n['notice-description'] || n['body'] || '';
      const title = n['title'] || n['subject'] || '';
      const combined = (desc + ' ' + title).trim();

      return {
        id: n['notice-id'] || n['id'] || '',
        company: n['company-name'] || extractCompany(combined) || '—',
        liquidator: extractLiquidator(combined) || '—',
        firm: extractFirm(combined) || '—',
        date: n['publish-date'] || n['published-date'] || n['date'] || '',
        url: n['_links']?.self?.href
          || (n['notice-id'] ? 'https://www.thegazette.co.uk/notice/' + n['notice-id'] : '#'),
        raw: combined.substring(0, 400)
      };
    });

    res.status(200).json({
      total: data['total'] || data['totalResults'] || parsed.length,
      notices: parsed,
      debug: { url, status: response.status, keys: Object.keys(data) }
    });

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

function extractCompany(text) {
  const patterns = [
    /(?:in the matter of|re:?)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc|Inc|Corp)\.?)/i,
    /^([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/m,
    /company[:\s]+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/i
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
    /appointed[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i,
    /I,\s+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,3}),?\s+of/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractFirm(text) {
  const patterns = [
    /of\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|LLC|Ltd|Limited|Partners|Group|Associates|Advisory|Restructuring|Insolvency|Recovery|Solutions))/,
    /(?:firm|practice)[:\s]+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|Ltd|Limited|Partners|Group))/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}
