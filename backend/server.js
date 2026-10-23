const SAFER_QUERY_URL = "https://safer.fmcsa.dot.gov/query.asp";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5000);
const webKey = process.env.FMCSA_WEB_KEY;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SAFER_URL =
  "https://safer.fmcsa.dot.gov/CompanySnapshot.aspx";

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "FMCSA Carrier Lookup API"
  });
});

// --------------------------------------------------
// FMCSA API REQUEST
// --------------------------------------------------

async function fmcsaGet(path) {
  const url = new URL(
    `https://mobile.fmcsa.dot.gov/qc/services/${path}`
  );

  url.searchParams.set(
    "webKey",
    process.env.FMCSA_WEB_KEY
  );

  const response = await fetch(url);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `FMCSA API error: ${response.status}`
    );
  }

  return data;
}


async function fetchSaferSnapshot(docketNumber) {
  const response = await fetch(SAFER_QUERY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      searchtype: "ANY",
      query_type: "queryCarrierSnapshot",
      query_param: "MC_MX",
      query_string: String(docketNumber),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`SAFER request failed: HTTP ${response.status}`);
  }

  return await response.text();
}





function extractSaferField(html, label) {
  const escapedLabel = label.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const rowRegex = new RegExp(
    `<TH\\b[^>]*>[\\s\\S]*?${escapedLabel}\\s*:?\\s*<\\/A>\\s*<\\/TH>\\s*<TD\\b[^>]*>([\\s\\S]*?)<\\/TD>`,
    "i"
  );

  const match = html.match(rowRegex);
  if (!match) return "";

  return match[1]
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code))
    )
    .replace(/\s+/g, " ")
    .trim();
}


function parseSaferSnapshot(html) {
  const usdNumber = extractSaferField(html, "USDOT Number");
  const name = extractSaferField(html, "Legal Name");
  const usdStatus = extractSaferField(html, "USDOT Status");
  const authority = extractSaferField(
    html,
    "Operating Authority Status"
  );
  const powerUnits = extractSaferField(html, "Power Units");
  const phone = extractSaferField(html, "Phone");

  let operatingStatus =
    "Not Available in SAFER — Verify Number";

  if (/NOT AUTHORIZED/i.test(authority)) {
    operatingStatus = "Not Authorized";
  } else if (/AUTHORIZED FOR:/i.test(authority)) {
    operatingStatus = "Authorized";
  }

  return {
    dotNumber: usdNumber,
    name,
    usdStatus,
    authority,
    powerUnits,
    phone,
    operatingStatus,
  };
}



function getDotNumber(data) {
  const carrier = getCarrier(data);
  const firstItem = getContent(data)[0];

  return String(
    carrier?.dotNumber ??
    firstItem?.dotNumber ??
    firstItem?.carrier?.dotNumber ??
    ""
  ).trim();
}

function findValues(data, keys) {
  const wanted = new Set(
    keys.map(key => key.toLowerCase())
  );

  const results = [];

  function visit(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (
        wanted.has(key.toLowerCase()) &&
        item !== null &&
        item !== undefined &&
        item !== ""
      ) {
        results.push(item);
      }

      if (item && typeof item === "object") {
        visit(item);
      }
    }
  }

  visit(data);
  return results;
}

function normalizeFlag(value) {
  const flag = String(value ?? "")
    .trim()
    .toUpperCase();

  if (["Y", "YES", "TRUE", "1"].includes(flag)) {
    return "Y";
  }

  if (["N", "NO", "FALSE", "0"].includes(flag)) {
    return "N";
  }

  return "";
}

// --------------------------------------------------
// OUT OF SERVICE DETECTION
// --------------------------------------------------

function hasOosOrder(data) {
  if (!data) return false;

  const flags = findValues(data, [
    "outOfService",
    "outOfServiceStatus",
    "outOfServiceOrder",
    "oosIndicator",
    "hasOutOfServiceOrder"
  ]);

  return flags.some(value => {
    if (value && typeof value === "object") {
      return false;
    }

    const flag = String(value)
      .trim()
      .toUpperCase();

    return [
      "Y",
      "YES",
      "TRUE",
      "1",
      "OOS",
      "OUT OF SERVICE",
      "OUT OF SERVICE ORDER"
    ].includes(flag);
  });
}

function isOutOfService(carrier, details) {
  return (
    hasOosOrder(carrier) ||
    hasOosOrder(details?.carrierRecord) ||
    hasOosOrder(details?.outOfService)
  );
}

// --------------------------------------------------
// AUTHORITY STATUS
// --------------------------------------------------

function getAuthorityCategories(carrier, details) {
  const sources = [
    carrier,
    details?.carrierRecord,
    details?.authority
  ];

  const fields = [
    {
      key: "commonAuthorityStatus",
      label: "Motor Carrier of Property"
    },
    {
      key: "contractAuthorityStatus",
      label: "Contract Carrier"
    },
    {
      key: "brokerAuthorityStatus",
      label: "Broker"
    }
  ];

  const categories = [];

  for (const field of fields) {
    let status = "";

    for (const source of sources) {
      const values = findValues(source, [field.key]);

      const match = values
        .map(value =>
          String(value).trim().toUpperCase()
        )
        .find(value =>
          ["A", "N", "I"].includes(value)
        );

      if (match) {
        status = match;
        break;
      }
    }

    if (status === "A") {
      categories.push(field.label);
    }
  }

  return categories;
}



function determineOperatingStatus(carrier, details, expectedDocket) {
  const record =
    getCarrier(details?.carrierRecord) ||
    carrier ||
    {};

  const authorityCategories = getAuthorityCategories(
    record,
    details
  );

  if (isOutOfService(record, details)) {
    return {
      status: "Out of Service",
      authorityCategories,
      verified: false
    };
  }

  const docketEntries = getContent(details?.docketNumbers);

  const matchingDocket = docketEntries.some((entry) => {
    const number = String(entry?.docketNumber ?? "").trim();
    const prefix = String(entry?.prefix ?? "").trim().toUpperCase();

    return (
      number === String(expectedDocket) &&
      ["MC", "MX"].includes(prefix)
    );
  });

  if (!matchingDocket) {
    return {
      status: "Not Available in SAFER — Verify Number",
      authorityCategories: [],
      verified: false
    };
  }

  // FMCSA authority codes alone do not verify SAFER's displayed status.
  return {
    status: "Not Available in SAFER — Verify Number",
    authorityCategories: [],
    verified: false
  };
}



// --------------------------------------------------
// MC / MX LOOKUP
// --------------------------------------------------


app.get("/api/carriers/:identifier", async (req, res) => {
  const input = String(req.params.identifier || "").trim();

  const match = input.match(/^(?:(MC|MX)[\s-]*)?(\d+)$/i);

  if (!match) {
    return res.status(400).json({
      error: "Invalid MC/MX number.",
      message: "Example: MC-1819001 or MX-123456",
    });
  }

  const identifierType = (match[1] || "MC").toUpperCase();
  const docketNumber = match[2];

  try {
    const html = await fetchSaferSnapshot(docketNumber);
    const safer = parseSaferSnapshot(html);
    console.log("SAFER HTML length:", html.length);
    console.log("SAFER parsed result:", safer);
    console.log("SAFER HTML preview:", html.slice(0, 1500));

    // Check that SAFER returned a carrier result.
    if (!safer.name || !safer.dotNumber || !safer.authority) {
      return res.status(404).json({
        input,
        identifierType,
        docketNumber,
        recordFound: false,
        operatingStatus: "Not Available in SAFER — Verify Number",
        statusVerified: false,
        authorityCategories: [],
        source: "FMCSA SAFER Company Snapshot",
        saferUrl: SAFER_URL,
        message: "A matching SAFER carrier result could not be verified.",
      });
    }

    // Validate the requested MC/MX number against the result page.
    const requestedDocketPattern = new RegExp(
      `\\b${identifierType}\\s*[-:]?\\s*${docketNumber}\\b`,
      "i"
    );

    if (!requestedDocketPattern.test(html)) {
      return res.status(404).json({
        input,
        identifierType,
        docketNumber,
        recordFound: false,
        operatingStatus: "Not Available in SAFER — Verify Number",
        statusVerified: false,
        authorityCategories: [],
        source: "FMCSA SAFER Company Snapshot",
        saferUrl: SAFER_URL,
        message: "The returned result could not be matched to the requested number.",
      });
    }

    const powerUnitsMatch = String(
      safer.powerUnits ?? ""
    ).match(/\d+/);

    const powerUnits = powerUnitsMatch
      ? Number(powerUnitsMatch[0])
      : null;

    const carrier = {
      dotNumber: safer.dotNumber,
      legalName: safer.name,
      phone: safer.phone,
      totalPowerUnits: powerUnits,
      powerUnits,
      totalDrivers: null,
      phyCity: "",
      phyState: "",
      phyStreet: "",
      phyZipcode: "",
      allowedToOperate: safer.operatingStatus === "Authorized" ? "Y" : "N",
    };

    const statusVerified = [
      "Authorized",
      "Not Authorized",
    ].includes(safer.operatingStatus);

    const result = {
      input,
      identifierType,
      docketNumber,
      dotNumber: safer.dotNumber,
      recordFound: true,
      carrier,
      name: safer.name,
      phone: safer.phone,
      powerUnits,
      drivers: null,
      operatingStatus: safer.operatingStatus,
      statusVerified,
      authorityCategories: [],
      usdStatus: safer.usdStatus,
      authority: safer.authority,
      source: "FMCSA SAFER Company Snapshot",
      retrievedAt: new Date().toISOString(),
      saferUrl: SAFER_URL,
    };

    console.log("MC/MX:", input);
    console.log("DOT:", safer.dotNumber);
    console.log("Power Units:", powerUnits);
    console.log("Operating Status:", safer.operatingStatus);

    return res.json(result);
  } catch (error) {
    console.error(
      "SAFER lookup error:",
      error instanceof Error ? error.message : error
    );

    return res.status(502).json({
      input,
      identifierType,
      docketNumber,
      recordFound: false,
      operatingStatus: "Not Available in SAFER — Verify Number",
      statusVerified: false,
      authorityCategories: [],
      error: "SAFER lookup failed.",
      message: error instanceof Error ? error.message : "Unknown error",
      saferUrl: SAFER_URL,
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(port, () => {
  console.log(
    `FMCSA Carrier API running at http://localhost:${port}`
  );
});
