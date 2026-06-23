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

    // Gazette returns an Atom-style feed: notices are under 'entry', total under 'f:total'
    const notices = data['entry'] || [];
    const total = data['f:total'] || notices.length;

    console.log('Notices found:', notices.length, 'Total:', total);

    const parsed = notices.map(n => {
      const desc = n['summary'] || n['content'] || n['f:body'] || '';
      const title = n['title'] || '';
      const combined = (desc + ' ' + title).trim();

      // Notice ID and URL from 'id' field (a URL) or 'link'
      const noticeUrl = n['id'] || (Array.isArray(n['link'])
        ? n['link'].find(l => l['@_rel'] === 'alternate')?.['@_href']
        : n['link']) || '#';

      const noticeId = noticeUrl.split('/').pop();

      return {
        id: noticeId,
        company: n['f:company-name'] || extractCompany(combined) || '—',
        liquidator: n['f:person-name'] || extractLiquidator(combined) || '—',
        firm: n['f:organisation-name'] || extractFirm(combined) || '—',
        date: n['published'] || n['updated'] || '',
        url: noticeUrl.startsWith('http') ? noticeUrl : 'https://www.thegazette.co.uk/notice/' + noticeId,
        raw: combined.substring(0, 400)
      };
    });

    res.status(200).json({
      total,
      notices: parsed,
      debug: { url, status: response.status, keys: Object.keys(data), entryCount: notices.length }
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
