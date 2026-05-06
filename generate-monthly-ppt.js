require("dotenv").config({ override: true });
const { Client } = require("pg");
const pptxgen = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

const ACCOUNT_ID = "122-674-7536";

function money(value) {
  return `$${Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

function money2(value) {
  return `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function roas(value) {
  return `${Number(value || 0).toFixed(2)}x`;
}

function pct(value) {
  const n = Number(value || 0);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function changePercent(current, previous) {
  current = Number(current || 0);
  previous = Number(previous || 0);
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return 100;
  return ((current - previous) / previous) * 100;
}

function classifyMarket(campaignName = "") {
  const name = campaignName.toLowerCase();
  if (name.includes("secondary market") || name.includes("secondary")) return "secondary";
  if (name.includes("main market") || name.includes("main")) return "main";
  return "unknown";
}

function classifyType(campaignName = "") {
  const name = campaignName.toLowerCase();
  if (name.includes("dg") || name.includes("demand gen")) return "DG";
  if (name.includes("sem") || name.includes("search")) return "SEM";
  return "OTHER";
}

function emptyTotals() {
  return {
    cost: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
  };
}

function addMetrics(target, row) {
  target.cost += Number(row.cost || 0);
  target.impressions += Number(row.impressions || 0);
  target.clicks += Number(row.clicks || 0);
  target.conversions += Number(row.conversions || 0);
  target.conversion_value += Number(row.conversion_value || 0);
}

function finishTotals(t) {
  return {
    ...t,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
    roas: t.cost > 0 ? t.conversion_value / t.cost : 0,
  };
}

function monthKey(date) {
  if (!date) return "";

  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  const raw = String(date);

  if (/^\d{4}-\d{2}/.test(raw)) {
    return raw.slice(0, 7);
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  return raw.slice(0, 7);
}

function shortName(name = "") {
  const parts = String(name).split("|").map((p) => p.trim()).filter(Boolean);
  const ignored = new Set([
    "sem",
    "dg",
    "g2g",
    "all user",
    "all users",
    "main market",
    "secondary market",
    "non-branded",
    "branded",
    "global",
  ]);
  const useful = parts.filter((p) => !ignored.has(p.toLowerCase()));
  return useful.slice(-2).join(" ") || name;
}

function aggregate(snapshots, market, type) {
  const totals = emptyTotals();
  const adGroupMap = new Map();
  const wasteTerms = new Map();
  const keywordOpps = new Map();

  for (const snap of snapshots) {
    const payload = snap.payload || {};

    for (const campaign of payload.campaigns || []) {
      const name = campaign.campaign_name || campaign.campaign_key || "";
      if (name.toLowerCase().includes("branding")) continue;
      if (classifyMarket(name) !== market) continue;
      if (classifyType(name) !== type) continue;
      addMetrics(totals, campaign);
    }

    for (const ag of payload.ad_groups || []) {
      const campaignName = ag.campaign_name || "";
      const agName = ag.ad_group_name || "";
      if (campaignName.toLowerCase().includes("branding")) continue;
      if (classifyMarket(campaignName) !== market) continue;
      if (classifyType(campaignName) !== type) continue;
      if (!agName) continue;

      const key = `${campaignName}|||${agName}`;
      if (!adGroupMap.has(key)) {
        adGroupMap.set(key, {
          campaign_name: campaignName,
          ad_group_name: agName,
          ...emptyTotals(),
        });
      }
      addMetrics(adGroupMap.get(key), ag);
    }

    for (const term of payload.search_terms || []) {
      const campaignName = term.campaign_name || "";
      const searchTerm = term.search_term || "";
      const cost = Number(term.cost || 0);
      const conversions = Number(term.conversions || 0);
      const conversionValue = Number(term.conversion_value || 0);
      const termRoas = cost > 0 ? conversionValue / cost : 0;

      if (!searchTerm) continue;
      if (campaignName.toLowerCase().includes("branding")) continue;
      if (classifyMarket(campaignName) !== market) continue;
      if (classifyType(campaignName) !== type) continue;

      if (cost >= 1 && conversions === 0) {
        const key = `${campaignName}|||${searchTerm}`;
        if (!wasteTerms.has(key)) {
          wasteTerms.set(key, { campaign_name: campaignName, search_term: searchTerm, cost: 0 });
        }
        wasteTerms.get(key).cost += cost;
      }

      if (cost >= 1 && conversions > 0 && termRoas >= 10) {
        const key = `${campaignName}|||${searchTerm}`;
        if (!keywordOpps.has(key)) {
          keywordOpps.set(key, {
            campaign_name: campaignName,
            search_term: searchTerm,
            cost: 0,
            conversion_value: 0,
          });
        }
        const item = keywordOpps.get(key);
        item.cost += cost;
        item.conversion_value += conversionValue;
      }
    }
  }

  const adGroups = Array.from(adGroupMap.values()).map((x) => ({
    ...x,
    ...finishTotals(x),
  }));

  return {
    totals: finishTotals(totals),
    adGroups,
    wasteTerms: Array.from(wasteTerms.values()).sort((a, b) => b.cost - a.cost).slice(0, 6),
    keywordOpps: Array.from(keywordOpps.values())
      .map((x) => ({ ...x, roas: x.cost > 0 ? x.conversion_value / x.cost : 0 }))
      .sort((a, b) => b.conversion_value - a.conversion_value)
      .slice(0, 6),
  };
}

function compareDrivers(current, previous) {
  const prevMap = new Map(previous.adGroups.map((x) => [`${x.campaign_name}|||${x.ad_group_name}`, x]));
  const rows = current.adGroups.map((c) => {
    const p = prevMap.get(`${c.campaign_name}|||${c.ad_group_name}`) || finishTotals(emptyTotals());
    return {
      campaign_name: c.campaign_name,
      ad_group_name: c.ad_group_name,
      current: c,
      previous: p,
      cv_delta: c.conversion_value - p.conversion_value,
      roas_delta: changePercent(c.roas, p.roas),
    };
  });

  return {
    winners: rows.filter((r) => r.current.conversion_value > 0).sort((a, b) => b.cv_delta - a.cv_delta).slice(0, 5),
    losers: rows.filter((r) => r.current.cost > 0).sort((a, b) => a.cv_delta - b.cv_delta).slice(0, 5),
  };
}

async function fetchMonthlySnapshots(client) {
  const result = await client.query(`
    WITH ranked AS (
      SELECT
        id,
        report_date,
        payload,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY report_date, account_id
          ORDER BY created_at DESC
        ) AS rn
      FROM ads_metric_snapshots
      WHERE source = 'google_ads_script'
        AND report_date IS NOT NULL
    )
    SELECT id, report_date, payload, created_at
    FROM ranked
    WHERE rn = 1
    ORDER BY report_date ASC;
  `);

  return result.rows;
}

function latestTwoMonths(snapshots) {
  const months = Array.from(new Set(snapshots.map((s) => monthKey(s.report_date)))).sort();

  if (months.length === 0) {
    throw new Error("No monthly snapshot data found.");
  }

  const currentMonth = months[months.length - 1];
  const previousMonth = months[months.length - 2] || null;

  return {
    currentMonth,
    previousMonth,
    currentSnapshots: snapshots.filter((s) => monthKey(s.report_date) === currentMonth),
    previousSnapshots: previousMonth ? snapshots.filter((s) => monthKey(s.report_date) === previousMonth) : [],
  };
}

function addTitle(slide, text, subtitle) {
  slide.addText(text, {
    x: 0.5,
    y: 0.45,
    w: 12.2,
    h: 0.45,
    fontSize: 24,
    bold: true,
    color: "111827",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.5,
      y: 0.95,
      w: 12,
      h: 0.28,
      fontSize: 10,
      color: "6B7280",
    });
  }
}

function addTable(slide, rows, x, y, w, h) {
  slide.addTable(rows, {
    x,
    y,
    w,
    h,
    border: { type: "solid", color: "D1D5DB", pt: 0.5 },
    fontSize: 9,
    color: "111827",
    margin: 0.05,
    valign: "mid",
    fit: "shrink",
  });
}

function segmentRows(label, current, previous) {
  const c = current.totals;
  const p = previous.totals;
  return [
    [
      { text: "Metric", options: { bold: true, fill: "E5E7EB" } },
      { text: "Current", options: { bold: true, fill: "E5E7EB" } },
      { text: "Previous", options: { bold: true, fill: "E5E7EB" } },
      { text: "MoM", options: { bold: true, fill: "E5E7EB" } },
    ],
    ["Ad spend", money2(c.cost), money2(p.cost), pct(changePercent(c.cost, p.cost))],
    ["Impressions", Math.round(c.impressions).toLocaleString(), Math.round(p.impressions).toLocaleString(), pct(changePercent(c.impressions, p.impressions))],
    ["Clicks", Math.round(c.clicks).toLocaleString(), Math.round(p.clicks).toLocaleString(), pct(changePercent(c.clicks, p.clicks))],
    ["CTR", `${c.ctr.toFixed(2)}%`, `${p.ctr.toFixed(2)}%`, pct(changePercent(c.ctr, p.ctr))],
    ["Conversions", Math.round(c.conversions).toLocaleString(), Math.round(p.conversions).toLocaleString(), pct(changePercent(c.conversions, p.conversions))],
    ["Conv Value", money2(c.conversion_value), money2(p.conversion_value), pct(changePercent(c.conversion_value, p.conversion_value))],
    ["ROAS", roas(c.roas), roas(p.roas), pct(changePercent(c.roas, p.roas))],
  ];
}

function bulletText(lines) {
  return lines.map((line) => ({ text: line, options: { bullet: { type: "ul" } } }));
}

function addBullets(slide, title, lines, x, y, w, h) {
  slide.addText(title, { x, y, w, h: 0.25, fontSize: 12, bold: true, color: "111827" });
  slide.addText(bulletText(lines.length ? lines : ["Not enough data yet."]), {
    x,
    y: y + 0.35,
    w,
    h,
    fontSize: 9,
    color: "111827",
    breakLine: false,
    fit: "shrink",
  });
}

function createSegmentSlide(pptx, title, current, previous, threshold, subtitle) {
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  addTitle(slide, title, subtitle);

  addTable(slide, segmentRows(title, current, previous), 0.55, 1.45, 5.8, 3.0);

  const drivers = compareDrivers(current, previous);

  const winners = drivers.winners.slice(0, 5).map((d) => {
    const status = d.current.roas >= threshold ? "above threshold" : "below threshold";
    return `${shortName(d.ad_group_name)} — ${roas(d.previous.roas)} → ${roas(d.current.roas)}, ${status}`;
  });

  const losers = drivers.losers.slice(0, 5).map((d) => {
    const status = d.current.roas >= threshold ? "above threshold" : "below threshold";
    return `${shortName(d.ad_group_name)} — ${roas(d.previous.roas)} → ${roas(d.current.roas)}, ${status}`;
  });

  addBullets(slide, "Key drivers increasing conversion metrics", winners, 6.65, 1.45, 6.0, 1.8);
  addBullets(slide, "Key drivers decreasing conversion metrics", losers, 6.65, 3.45, 6.0, 1.8);

  const waste = current.wasteTerms.slice(0, 4).map((w) => `${w.search_term} — ${money2(w.cost)} wasted in ${shortName(w.campaign_name)}`);
  addBullets(slide, "Search-term waste", waste, 0.55, 5.0, 5.8, 1.25);

  const opps = current.keywordOpps.slice(0, 4).map((k) => `${k.search_term} — ${money2(k.cost)} → ${money2(k.conversion_value)}, ${roas(k.roas)}`);
  addBullets(slide, "Keyword opportunities", opps, 6.65, 5.0, 6.0, 1.25);

  return slide;
}

function createSummarySlide(pptx, summary, currentMonth, previousMonth) {
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  addTitle(slide, `Marketing — ${currentMonth} Report`, `G2G Ad Account ${ACCOUNT_ID}`);

  slide.addText("G2G PAID ADS PRODUCT FOCUS", {
    x: 0.55,
    y: 1.45,
    w: 12,
    h: 0.35,
    fontSize: 18,
    bold: true,
    color: "111827",
  });

  const rows = [
    [
      { text: "Platform", options: { bold: true, fill: "E5E7EB" } },
      { text: "Ad spend", options: { bold: true, fill: "E5E7EB" } },
      { text: "ROAS", options: { bold: true, fill: "E5E7EB" } },
      { text: "Conv Value", options: { bold: true, fill: "E5E7EB" } },
      { text: "MoM Spend", options: { bold: true, fill: "E5E7EB" } },
      { text: "MoM ROAS", options: { bold: true, fill: "E5E7EB" } },
      { text: "MoM CV", options: { bold: true, fill: "E5E7EB" } },
    ],
  ];

  for (const row of summary) {
    rows.push([
      row.name,
      money2(row.current.totals.cost),
      roas(row.current.totals.roas),
      money2(row.current.totals.conversion_value),
      pct(changePercent(row.current.totals.cost, row.previous.totals.cost)),
      pct(changePercent(row.current.totals.roas, row.previous.totals.roas)),
      pct(changePercent(row.current.totals.conversion_value, row.previous.totals.conversion_value)),
    ]);
  }

  addTable(slide, rows, 0.55, 2.05, 12.2, 2.0);

  slide.addText(
    `Automated first draft based on Google Ads daily snapshots. Current period: ${currentMonth}. Previous period: ${previousMonth || "not enough data yet"}. Branding, OffGamers, and A/B testing sections require separate source data and are not included in this first automated draft.`,
    {
      x: 0.55,
      y: 4.55,
      w: 12.0,
      h: 1.0,
      fontSize: 12,
      color: "374151",
      fit: "shrink",
    }
  );

  slide.addText("Upcoming focus", {
    x: 0.55,
    y: 5.85,
    w: 3,
    h: 0.3,
    fontSize: 14,
    bold: true,
    color: "111827",
  });

  slide.addText(
    bulletText([
      "Continue daily search-term optimization with ADD_NEGATIVES and ADD_KEYWORD workflow.",
      "Use keyword-level data to identify PAUSE_KEYWORD opportunities.",
      "Add budget/lost impression share data before enabling budget recommendation slides.",
    ]),
    {
      x: 0.75,
      y: 6.2,
      w: 11.5,
      h: 0.8,
      fontSize: 10,
      color: "111827",
      fit: "shrink",
    }
  );
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    const snapshots = await fetchMonthlySnapshots(client);
    const { currentMonth, previousMonth, currentSnapshots, previousSnapshots } = latestTwoMonths(snapshots);

    const mainSemCurrent = aggregate(currentSnapshots, "main", "SEM");
    const mainSemPrevious = aggregate(previousSnapshots, "main", "SEM");
    const mainDgCurrent = aggregate(currentSnapshots, "main", "DG");
    const mainDgPrevious = aggregate(previousSnapshots, "main", "DG");

    const secondarySemCurrent = aggregate(currentSnapshots, "secondary", "SEM");
    const secondarySemPrevious = aggregate(previousSnapshots, "secondary", "SEM");
    const secondaryDgCurrent = aggregate(currentSnapshots, "secondary", "DG");
    const secondaryDgPrevious = aggregate(previousSnapshots, "secondary", "DG");

    const pptx = new pptxgen();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "G2G Ads Automation";
    pptx.subject = "G2G Monthly Google Ads Report";
    pptx.title = `Marketing - ${currentMonth} Report`;

    createSummarySlide(
      pptx,
      [
        { name: "Main market - SEM", current: mainSemCurrent, previous: mainSemPrevious },
        { name: "Main market - DG", current: mainDgCurrent, previous: mainDgPrevious },
        { name: "2nd market - SEM", current: secondarySemCurrent, previous: secondarySemPrevious },
        { name: "2nd market - DG", current: secondaryDgCurrent, previous: secondaryDgPrevious },
      ],
      currentMonth,
      previousMonth
    );

    createSegmentSlide(pptx, "Main Market Ads – SEM (Google Ads)", mainSemCurrent, mainSemPrevious, 10, `${currentMonth} vs ${previousMonth || "previous period"}`);
    createSegmentSlide(pptx, "Main Market Ads – Demand Gen (Google Ads)", mainDgCurrent, mainDgPrevious, 20, `${currentMonth} vs ${previousMonth || "previous period"}`);
    createSegmentSlide(pptx, "Secondary Market – SEM", secondarySemCurrent, secondarySemPrevious, 10, `${currentMonth} vs ${previousMonth || "previous period"}`);
    createSegmentSlide(pptx, "Secondary Market – Demand Gen", secondaryDgCurrent, secondaryDgPrevious, 20, `${currentMonth} vs ${previousMonth || "previous period"}`);

    const outDir = path.join(process.cwd(), "reports");
    fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `Marketing-${currentMonth}-Google-Ads-Report.pptx`);
    await pptx.writeFile({ fileName: outPath });

    console.log(`Created monthly PowerPoint: ${outPath}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to generate monthly PPT:");
  console.error(error.message);
  process.exit(1);
});
