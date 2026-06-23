export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, liquidator, from, to, pageSize = 50 } = req.query;

  let q = '"appointment of liquidator"';
  if (company) q += ' "' + company + '"';
  if (liquidator) q += ' "' + liquidator + '"';

  const params = new URLSearchParams({
    'results-page-size': pageSize,
    'category-code': 'I2',
    'start-publish-date': from,
    'end-publish-date': to,
    'q': q,
    'format': 'application/json'
  });

  try {
    const url = `https://www.thegazette.co.uk/all-notices/notice?${params}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'InsolvencyTracker/1.0' }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: 'Gazette API error', detail: text });
    }

    const data = await response.json();
    const notices = data['_embedded']?.['gazette-notice'] || [];

    const parsed = notices.map(n => {
      const desc = n['description'] || n['notice-description'] || '';
      const title = n['title'] || '';
      const combined = desc + ' ' + title;

      return {
        id: n['notice-id'] || '',
        company: extractCompany(combined) || n['company-name'] || '—',
        liquidator: extractLiquidator(combined) || '—',
        firm: extractFirm(combined) || '—',
        date: n['publish-date'] || n['date'] || '',
        url: n['_links']?.self?.href || ('https://www.thegazette.co.uk/notice/' + (n['notice-id'] || '')),
        raw: combined.substring(0, 300)
      };
    });

    res.status(200).json({ total: data['total'] || parsed.length, notices: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function extractCompany(text) {
  const m = text.match(/(?:in the matter of|re:?)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc|Inc|Corp))/i);
  if (m) return m[1].trim();
  const m2 = text.match(/^([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc))/);
  return m2 ? m2[1].trim() : null;
}

function extractLiquidator(text) {
  const m = text.match(/(?:liquidator|appointed)[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/i);
  return m ? m[1].trim() : null;
}

function extractFirm(text) {
  const m = text.match(/of\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|Ltd|Limited|Partners|Group|Associates|Advisory|Restructuring|Insolvency|Recovery))/);
  return m ? m[1].trim() : null;
}
