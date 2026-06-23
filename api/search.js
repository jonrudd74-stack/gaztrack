export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Debug mode: fetch a single notice by ID to inspect its full structure
  if (req.query.noticeId) {
    const url = `https://www.thegazette.co.uk/id/notice/${req.query.noticeId}?format=application/json`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    try { return res.status(200).json(JSON.parse(text)); }
    catch(e) { return res.status(200).send(text); }
  }

  const { company, liquidator, from, to, pageSize = 50 } = req.query;

  // 2442 = CVL Appointment of Liquidator
  // 2444 = MVL Appointment of Liquidator
  const APPOINTMENT_CODES = new Set(['2442', '2444']);

  try {
    // Fetch multiple pages to get enough appointment notices
    // Gazette max page size is 200
    const maxPages = 10;
    let allAppointments = [];
    let pageNum = 1;
    let totalFromApi = 0;

    while (pageNum <= maxPages) {
      const params = new URLSearchParams({
        'results-page-size': 200,
        'page': pageNum,
        'start-publish-date': from,
        'end-publish-date': to,
        'format': 'application/json'
      });

      const url = `https://www.thegazette.co.uk/insolvency/notice?${params}`;
      console.log(`Fetching page ${pageNum}:`, url);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; InsolvencyTracker/1.0)' }
      });

      if (!response.ok) break;
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch(e) { break; }

      const entries = data['entry'] || [];
      if (entries.length === 0) break;

      totalFromApi = data['f:total'] || totalFromApi;
      const pageStop = parseInt(data['f:page-stop'] || 0);
      const pageStart = parseInt(data['f:page-start'] || 0);

      // Filter to appointment notices on this page
      const appointments = entries.filter(n => APPOINTMENT_CODES.has(String(n['f:notice-code'] || '')));
      allAppointments = allAppointments.concat(appointments);

      // Stop if we have enough or reached the end
      if (allAppointments.length >= parseInt(pageSize) || pageStop >= parseInt(totalFromApi) || entries.length < 200) break;
      pageNum++;
    }

    // Parse all appointment notices
    let parsed = allAppointments.map(n => parseNotice(n));

    // Filter by company/liquidator name if provided
    if (company) {
      parsed = parsed.filter(n =>
        n.company.toLowerCase().includes(company.toLowerCase()) ||
        n.raw.toLowerCase().includes(company.toLowerCase())
      );
    }
    if (liquidator) {
      parsed = parsed.filter(n =>
        n.liquidator.toLowerCase().includes(liquidator.toLowerCase()) ||
        n.raw.toLowerCase().includes(liquidator.toLowerCase())
      );
    }

    // Limit to requested page size
    const limited = parsed.slice(0, parseInt(pageSize));

    res.status(200).json({
      total: parsed.length,
      notices: limited,
      debug: { pagesfetched: pageNum, totalFromApi, appointmentsFound: allAppointments.length, afterNameFilter: parsed.length }
    });

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

function parseNotice(n) {
  const rawHtml = n['content'] || n['summary'] || n['f:body'] || '';
  const plain = stripHtml(rawHtml);
  const title = typeof n['title'] === 'string' ? n['title'] : (n['title']?.['#text'] || '');
  const combined = (plain + ' ' + title).trim();
  const noticeId = String(n['id'] || '').split('/').pop();
  const noticeUrl = String(n['id'] || '').startsWith('http') ? n['id'] : 'https://www.thegazette.co.uk/notice/' + noticeId;

  return {
    id: noticeId,
    noticeCode: n['f:notice-code'] || '—',
    company: n['f:company-name'] || extractCompany(combined, title) || title || '—',
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
  if (title && title.match(/Ltd|Limited|LLP|PLC|plc/i)) {
    return title.replace(/[-–—].*$/, '').trim();
  }
  const patterns = [
    /(?:in the matter of|re:?)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)/i,
    /(?:Name of Company|Company Name)[:\s]+([A-Z][A-Za-z0-9\s&',.()\-]+)/i,
    /([A-Z][A-Za-z0-9\s&',.()\-]+(?:Ltd|Limited|LLP|PLC|plc)\.?)\s+(?:–|-|—)/,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractLiquidator(text) {
  const patterns = [
    /(?:joint\s+)?liquidator[s]?[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i,
    /I,\s+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,3}),\s+of/,
    /appointed[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i,
    /Name of Liquidator[:\s]+([A-Z][a-z]+([\s\-][A-Z][a-z]+){1,4})/i
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractFirm(text) {
  const patterns = [
    /([A-Z][A-Za-z0-9\s&',.()\-]+(?:LLP|LLC))\b/,
    /(?:of|at)\s+([A-Z][A-Za-z0-9\s&',.()\-]+(?:Partners|Group|Associates|Advisory|Restructuring|Insolvency|Recovery|Solutions))/,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}
