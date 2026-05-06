require("dotenv").config({ override: true });

const { Client } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1) {
    console.log(text);
    throw new Error("Claude did not return JSON.");
  }

  return JSON.parse(text.slice(start, end + 1));
}

function parseBasicFields(rawText) {
  const text = String(rawText || "").trim();

  function pick(labelNames) {
    for (const label of labelNames) {
      const regex = new RegExp(
        `${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[A-Za-z ]+\\s*:|\\s+(?:Campaign|URL|Landing page|Budget|Product|Country|Market)\\s*:|$)`,
        "i"
      );
      const match = text.match(regex);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return undefined;
  }

  return {
    campaign: pick(["Campaign"]),
    url: pick(["URL", "Landing page", "Landing URL"]),
    budget: pick(["Budget", "Budget note"]),
    product: pick(["Product"]),
    country: pick(["Country"]),
    market: pick(["Market"]),
  };
}

async function getReceivedRequests(client) {
  const result = await client.query(`
    SELECT *
    FROM adgroup_creation_requests
    WHERE status = 'received'
    ORDER BY created_at ASC
    LIMIT 5;
  `);

  return result.rows;
}

async function saveDraft(client, id, parsedJson, draftJson) {
  await client.query(
    `
    UPDATE adgroup_creation_requests
    SET
      parsed_json = $2,
      draft_json = $3,
      status = 'drafted',
      drafted_at = now()
    WHERE id = $1;
    `,
    [id, parsedJson, draftJson]
  );
}

async function saveError(client, id, message) {
  await client.query(
    `
    UPDATE adgroup_creation_requests
    SET
      status = 'error',
      error_message = $2
    WHERE id = $1;
    `,
    [id, message]
  );
}

function formatDraftForConsole(request, draft) {
  const adGroups = draft.ad_groups || [];
  const firstAdGroup = adGroups[0] || {};
  const keywords = firstAdGroup.keywords || [];
  const negatives = firstAdGroup.negative_keywords || [];
  const ads = firstAdGroup.ads || [];
  const firstAd = ads[0] || {};

  const lines = [];

  lines.push("");
  lines.push("AD GROUP DRAFT");
  lines.push("========================================");
  lines.push(`Request ID: ${request.id}`);
  lines.push("");
  lines.push(`Target campaign: ${draft.target_campaign_name || "Needs confirmation"}`);
  lines.push(`New ad group: ${firstAdGroup.name || "Needs confirmation"}`);
  lines.push(`Landing page: ${draft.landing_page || "Missing"}`);
  lines.push(`Budget note: ${draft.budget_note || "Ad group uses existing campaign budget."}`);
  lines.push("");

  lines.push("Keywords:");
  if (keywords.length === 0) {
    lines.push("- No keywords generated.");
  } else {
    keywords.slice(0, 12).forEach((kw) => {
      lines.push(`- ${kw.match_type || "exact"}: ${kw.text}`);
    });
  }

  lines.push("");
  lines.push("Negative keywords:");
  if (negatives.length === 0) {
    lines.push("- No negatives generated.");
  } else {
    negatives.slice(0, 12).forEach((kw) => {
      lines.push(`- ${kw}`);
    });
  }

  lines.push("");
  lines.push("Responsive Search Ad draft:");
  lines.push("Headlines:");
  (firstAd.headlines || []).slice(0, 12).forEach((h) => lines.push(`- ${h}`));
  lines.push("Descriptions:");
  (firstAd.descriptions || []).slice(0, 4).forEach((d) => lines.push(`- ${d}`));

  lines.push("");
  lines.push("Status: Draft only. Not created in Google Ads yet.");
  lines.push("========================================");

  return lines.join("\n");
}

async function generateDraft(request) {
  const parsed = parseBasicFields(request.raw_text);

  const prompt = `
You are creating a safe Google Ads ad group draft for G2G.

The user requested a new ad group.

Raw request:
${request.raw_text}

Parsed fields:
${JSON.stringify(parsed, null, 2)}

Rules:
- Return ONLY valid JSON.
- Do not create a campaign. This is ad group draft only.
- The target campaign must be inferred from the Campaign field, but mark it as needs_confirmation if it is not exact.
- Budget is only a note. Ad groups do not have separate daily budget in Google Ads.
- Generate SEM/search ad group draft.
- Use exact match for strongest buying-intent terms.
- Use phrase match for close variants.
- Add obvious negative keywords like free, hack, generator, apk, mod, reddit, wiki when relevant.
- Create responsive search ad draft with up to 12 headlines and up to 4 descriptions.
- Keep headlines <= 30 characters if possible.
- Keep descriptions <= 90 characters if possible.
- Do not claim official partnership.
- Use safe marketplace language: fast delivery, secure checkout, trusted sellers, compare prices.

Required JSON shape:
{
  "request_type": "CREATE_ADGROUP_DRAFT",
  "target_campaign_name": "string",
  "target_campaign_needs_confirmation": true,
  "market": "main or secondary or unknown",
  "country": "string or unknown",
  "product": "string",
  "landing_page": "string",
  "budget_note": "string",
  "ad_groups": [
    {
      "name": "string",
      "keywords": [
        { "text": "string", "match_type": "exact or phrase" }
      ],
      "negative_keywords": ["string"],
      "ads": [
        {
          "headlines": ["string"],
          "descriptions": ["string"]
        }
      ]
    }
  ],
  "warnings": ["string"]
}
`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 3000,
    system:
      "You return only strict valid JSON. No markdown, no explanation outside JSON.",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

  const draft = extractJson(text);

  return {
    parsed,
    draft,
  };
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const requests = await getReceivedRequests(client);

    if (requests.length === 0) {
      console.log("No received ad group requests.");
      return;
    }

    for (const request of requests) {
      try {
        console.log(`Generating draft for ${request.id}`);

        const { parsed, draft } = await generateDraft(request);

        await saveDraft(client, request.id, parsed, draft);

        console.log(formatDraftForConsole(request, draft));
        console.log(`Draft generated for ${request.id}`);
      } catch (error) {
        console.error(`Failed for ${request.id}: ${error.message}`);
        await saveError(client, request.id, error.message);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error.message);
  process.exit(1);
});
