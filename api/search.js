export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, liquidator, from, to, pageSize = 50 } = req.query;

  // CVL-related notice codes:
  // 2442 = Appointment of Liquidator (CVL)
  // 2444 = Appointment of Liquidator (MVL)
  // 2441 = Notice of intention to appoint
  // We fetch without notice-type filter and filter ourselves since the API ignores it
  const params = new URLSearchParams({
    'results-page-size': pageSize,
    'start-publish-date': from,
    'end-publish-date': to,
    'format': 'application/json'
  });

  if (company) params.append('q', company);
  if (liquidator && !company) params.append('q', liquidator);
  if (company && liquidator) params.set('q', company + ' ' + liquidator);

  try {
    // Try the insolvency-specific endpoint first
    const url = `https://www.thegazette.co.uk/insolvency/notice?${params}`;
    console.log('Fetching:', url);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; InsolvencyTracker/1.0)'
      }
    });

    const text = await response.text();
    console.log('Status:', response.status, 'Preview:', text.substring(0, 200));

    if (!response.ok) {
      // Fallback: try all-notices with explicit notice-type
      return await fallbackSearch(req, res, params);
    }

    let data;
    try { data = JSON.parse(text); }
    catch(e) { return await fallbackSearch(req, res, params); }

    const allEntries = data['entry'] || [];
    const total = data['f:total'] || allEntries.length;

    // Filter to appointment of liquidator notices only
    // 2442 = CVL appointment, 2444 = MVL appointment, 2421 = compulsory appointment
    const APPOINTMENT_CODES = new Set(['2442','2444','2421','2422']);
    const entries = allEntries.filter(n => APPOINTMENT_CODES.has(String(n['f:notice-code'] || '')));

    const sampleCodes = allEntries.slice(0, 10).map(n => ({
      code: n['f:notice-code'],
      title: String(n['title']?.['#text'] || n['title'] || '').substring(0, 80)
    }));

    const parsed = entries.map(n => parseNotice(n));

    // Also client-filter by company/liquidator name if provided
    const filtered = parsed.filter(n => {
      if (company && !n.company.toLowerCase().includes(company.toLowerCase()) &&
          !n.raw.toLowerCase().includes(company.toLowerCase())) return false;
      if (liquidator && !n.liquidator.toLowerCase().includes(liquidator.toLowerCase()) &&
          !n.raw.toLowerCase().includes(liquidator.toLowerCase())) return false;
      return true;
    });

    res.status(200).json({
      total, notices: filtered,
      debug: { url, status: response.status, entryCount: allEntries.length, afterCodeFilter: entries.length, afterNameFilter: filtered.length, sampleCodes }
    });

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function fallbackSearch(req, res, params) {
  // Try all-notices endpoint with notice-type filter
  const url = `https://www.thegazette.co.uk/all-notices/notice?${params}`;
  console.log('Fallback fetch:', url);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch(e) {
      return res.status(500).json({ error: 'Could not parse fallback response', raw: text.substring(0, 300) });
    }
    const allEntries = data['entry'] || [];
    const total = data['f:total'] || allEntries.length;
    const sampleCodes = allEntries.slice(0, 10).map(n => ({
      code: n['f:notice-code'],
      title: String(n['title']?.['#text'] || n['title'] || '').substring(0, 80)
    }));
    const parsed = allEntries.map(n => parseNotice(n));
    return res.status(200).json({
      total, notices: parsed,
      debug: { url, status: response.status, entryCount: allEntries.length, sampleCodes }
    });
  } catch(err) {
    return res.status(500).json({ error: 'Fallback failed: ' + err.message });
  }
}

function parseNotice(n) {
  const rawHtml = n['content'] || n['summary'] || n['f:body'] || '';
  const plain = stripHtml(rawHtml);
  const title = typeof n['title'] === 'string' ? n['title'] : (n['title']?.['#text'] || '');
  const combined = (plain + ' ' + title).trim();
  const noticeId = String(n['id'] || '').split('/').pop();
  const noticeUrl = String(n['id'] || '').startsWith('http')
    ? n['id'] : 'https://www.thegazette.co.uk/notice/' + noticeId;

  return {
    id: noticeId,
    noticeCode: n['f:notice-code'] || '—',
    company: n['f:company-name'] || extractCompany(combined, title) || '—',
    liquidator: n['f:person-name'] || extractLiquidator(combined) || '—',
    firm: n['f:organisation-name'] || extractFirm(combined) || '—',
    date: (n['published'] || n['updated'] || '').substring(0, 10),
    url: noticeUrl,
    raw: combined.substring(0, 500)
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractCompany(text, title) {
  if (title) {
    const t = title.replace(/[-–—].*$/, '').trim();
    if (t.match(/Ltd|Limited|LLP|PLC|plc/i)) return t;
  }
  const patterns = [
    /(?:in the matter of|re:?)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/i,
    /([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)\s+(?:–|-|—)/,
    /^([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/m
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractLiquidator(text) {
  const patterns = [
    /(?:joint\s+)?liquidator[s]?[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i,
    /I[,\s]+([A-Z][A-Z\s]+(?:[A-Z][a-z]+\s?)+)[,\s]+of\s+/,
    /appointed[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractFirm(text) {
  const patterns = [
    /(?:of|at)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|LLC|Ltd|Limited|Partners|Group|Associates|Advisory|Restructuring|Insolvency|Recovery|Solutions))/,
    /(?:firm|practice)[:\s]+([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|Ltd|Limited|Partners|Group))/i
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}
