
import { useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  Database,
  ExternalLink,
  FileSearch,
  Gauge,
  LoaderCircle,
  Search,
  ShieldCheck,
  Truck,
  XCircle
} from "lucide-react";

type Carrier = {
  legalName?: string;
  dbaName?: string | null;
  dotNumber?: string | number;
  totalPowerUnits?: number | string | null;
  totalDrivers?: number | string | null;
  allowedToOperate?: string;
  commonAuthorityStatus?: string;
  contractAuthorityStatus?: string;
  brokerAuthorityStatus?: string;
  statusCode?: string;
  phyCity?: string;
  phyState?: string;
  phyStreet?: string;
  phyZipcode?: string;
  phone?: string;
  telephone?: string;
  telephoneNumber?: string;
  phoneNumber?: string;
  powerUnits?: number | string;
  [key: string]: unknown;
};

type Row = {
  input: string;
  identifierType: string;
  docketNumber: string;
  dotNumber: string;
  name: string;
  phone: string;
  powerUnits: number | null;
  drivers: string;
  operating: string;
  city: string;
  state: string;
  address: string;
  zip: string;
  saferUrl: string;
  error: string;
  recordFound: boolean | null;
};

const MAX_NUMBERS = 100;
const CONCURRENCY = 5;
const SAFER_URL =
  "https://safer.fmcsa.dot.gov/CompanySnapshot.aspx";

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(
  rows: Row[],
  fileName = "carrier-lookup-results.csv"
) {
  const headers = [
    "Input",
    "Record Result",
    "Carrier Name",
    "Phone",
    "MC/MX Type",
    "Docket Number",
    "USDOT Number",
    "Power Units",
    "Drivers",
    "Operating Status",
    "Address",
    "City",
    "State",
    "ZIP",
    "SAFER URL",
    "Message"
  ];

  const lines = [
    headers,
    ...rows.map((r) => [
      r.input,
      r.recordFound === false
        ? "Record Not Found"
        : r.error
          ? "Lookup Error"
          : "Record Found",
      r.name,
      r.phone,
      r.identifierType,
      r.docketNumber,
      r.dotNumber,
      r.powerUnits ?? "",
      r.drivers,
      r.operating,
      r.address,
      r.city,
      r.state,
      r.zip,
      r.saferUrl,
      r.error
    ])
  ];

  const csv =
    "\uFEFF" +
    lines
      .map((line) => line.map(csvEscape).join(","))
      .join("\r\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeNumber(value: string) {
  const match = value
    .trim()
    .match(/^(?:(MC|MX)[\s-]*)?(\d+)$/i);

  if (!match) return null;

  return `${(match[1] || "MC").toUpperCase()}-${match[2]}`;
}

function emptyRow(
  input: string,
  identifierType: string,
  docketNumber: string,
  message: string,
  recordFound: boolean | null = null
): Row {
  return {
    input,
    identifierType,
    docketNumber,
    dotNumber: "",
    name: "",
    phone: "",
    powerUnits: null,
    drivers: "",
    operating:
      recordFound === false
        ? "Record Not Found"
        : "Status Not Available",
    city: "",
    state: "",
    address: "",
    zip: "",
    saferUrl: SAFER_URL,
    error: message,
    recordFound
  };
}

// --------------------------------------------------
// FLEXIBLE FMCSA RESPONSE PARSER
// --------------------------------------------------

function getCarrierFromResponse(
  body: any
): Carrier | undefined {
  const candidates: any[] = [];

  function collect(value: any, depth = 0) {
    if (
      value == null ||
      typeof value !== "object" ||
      depth > 7
    ) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }

    if (
      value.dotNumber ||
      value.legalName ||
      value.dbaName ||
      value.totalPowerUnits != null ||
      value.phyCity
    ) {
      candidates.push(value);
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        child &&
        typeof child === "object" &&
        [
          "carrier",
          "content",
          "data",
          "basics",
          "carrierRecord"
        ].includes(key)
      ) {
        collect(child, depth + 1);
      }
    }
  }

  collect(body?.carrier);
  collect(body?.lookup);
  collect(body?.details?.carrierRecord);
  collect(body?.details?.basics);

  return candidates.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (
        item.dotNumber ||
        item.legalName ||
        item.dbaName
      )
  );
}

function findValue(
  sources: any[],
  keys: string[]
): unknown {
  const wanted = new Set(
    keys.map((key) => key.toLowerCase())
  );

  function search(value: any, depth = 0): unknown {
    if (
      value == null ||
      typeof value !== "object" ||
      depth > 7
    ) {
      return undefined;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = search(item, depth + 1);
        if (
          found !== undefined &&
          found !== null &&
          found !== ""
        ) {
          return found;
        }
      }

      return undefined;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        wanted.has(key.toLowerCase()) &&
        child !== undefined &&
        child !== null &&
        child !== ""
      ) {
        return child;
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const found = search(child, depth + 1);

        if (
          found !== undefined &&
          found !== null &&
          found !== ""
        ) {
          return found;
        }
      }
    }

    return undefined;
  }

  for (const source of sources) {
    const result = search(source);

    if (
      result !== undefined &&
      result !== null &&
      result !== ""
    ) {
      return result;
    }
  }

  return undefined;
}

function parseOperatingStatus(value: unknown) {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();

  if (status === "authorized") return "Authorized";

  if (status === "not authorized") {
    return "Not Authorized";
  }

  if (status === "out of service") {
    return "Out of Service";
  }

  if (
    status === "record not found" ||
    status === "not available in safer — verify number"
  ) {
    return "Not Available in SAFER — Verify Number";
  }

  return "Not Available in SAFER — Verify Number";
}

// --------------------------------------------------
// SINGLE LOOKUP
// --------------------------------------------------

async function lookupOne(input: string): Promise<Row> {
  const normalized = normalizeNumber(input);

  if (!normalized) {
    return emptyRow(
      input,
      "",
      "",
      "Invalid MC/MX number."
    );
  }

  const [identifierType, docketNumber] =
    normalized.split("-");

  try {
    const response = await fetch(
      `/api/carriers/${encodeURIComponent(normalized)}`
    );

    const body = await response.json().catch(() => ({}));

    if (
      response.status === 404 ||
      body.recordFound === false
    ) {
      return {
        ...emptyRow(
          input,
          identifierType,
          docketNumber,
          body.message ||
          "No matching carrier record was returned.",
          false
        ),
        saferUrl: body.saferUrl || SAFER_URL
      };
    }

    if (!response.ok) {
      return emptyRow(
        input,
        identifierType,
        docketNumber,
        body.message ||
        body.error ||
        `Lookup failed (HTTP ${response.status}).`
      );
    }

    const saferUrl = body.saferUrl || SAFER_URL;
    const carrier = getCarrierFromResponse(body);

    if (!carrier) {
      return {
        ...emptyRow(
          input,
          identifierType,
          docketNumber,
          "FMCSA returned a response, but carrier details could not be identified.",
          body.recordFound === true ? true : null
        ),
        dotNumber: String(body.dotNumber || ""),
        operating: parseOperatingStatus(
          body.operatingStatus
        ),
        saferUrl
      };
    }

    const sources = [
      carrier,
      body?.details?.basics,
      body?.details?.carrierRecord,
      body?.lookup
    ];

    const unitsRaw = findValue(sources, [
      "totalPowerUnits",
      "powerUnits",
      "totalPowerUnitsCount"
    ]);

    const unitsNumber =
      unitsRaw === "" || unitsRaw == null
        ? null
        : Number(unitsRaw);

    const powerUnits =
      unitsNumber !== null &&
      Number.isFinite(unitsNumber)
        ? unitsNumber
        : null;

    const driversValue = findValue(sources, [
      "totalDrivers",
      "driverTotal",
      "totalDriversCount"
    ]);

    const phoneValue = findValue(sources, [
      "phone",
      "telephone",
      "telephoneNumber",
      "phoneNumber"
    ]);

    const cityValue = findValue(sources, [
      "phyCity",
      "physicalCity"
    ]);

    const stateValue = findValue(sources, [
      "phyState",
      "physicalState"
    ]);

    const addressValue = findValue(sources, [
      "phyStreet",
      "physicalAddress",
      "address"
    ]);

    const zipValue = findValue(sources, [
      "phyZipcode",
      "physicalZipcode",
      "zipCode"
    ]);

    return {
      input,
      identifierType,
      docketNumber,
      dotNumber: String(
        body.dotNumber ?? carrier.dotNumber ?? ""
      ),
      name: String(
        carrier.legalName || carrier.dbaName || ""
      ),
      phone: String(phoneValue ?? ""),
      powerUnits,
      drivers:
        driversValue == null
          ? ""
          : String(driversValue),
      operating: parseOperatingStatus(
        body.operatingStatus
      ),
      city: String(cityValue ?? ""),
      state: String(stateValue ?? ""),
      address: String(addressValue ?? ""),
      zip: String(zipValue ?? ""),
      saferUrl,
      error: "",
      recordFound: true
    };
  } catch (error) {
    return emptyRow(
      input,
      identifierType,
      docketNumber,
      error instanceof Error
        ? error.message
        : "Lookup failed."
    );
  }
}

function statusClass(status: string) {
  if (status === "Authorized") return "status-good";
  if (status === "Not Authorized") return "status-bad";
  if (status === "Out of Service") {
    return "status-warning";
  }

  return "";
}

// --------------------------------------------------
// MAIN APP
// --------------------------------------------------

export default function App() {
  const [numbersText, setNumbersText] =
    useState("MC1819001");

  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [maxFiveOnly, setMaxFiveOnly] =
    useState(true);
  const [includeUnauthorized, setIncludeUnauthorized] =
    useState(true);
  const [showFailed, setShowFailed] = useState(true);

  const numbers = Array.from(
    new Set(
      numbersText
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_NUMBERS);

  async function runBulkLookup(
    e: FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();
    setError("");

    if (!numbers.length) {
      setError("Enter at least one MC/MX number.");
      return;
    }

    setBusy(true);
    setProgress(0);
    setRows([]);

    const results: Row[] = new Array(numbers.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;

        if (index >= numbers.length) return;

        results[index] = await lookupOne(numbers[index]);
        completed++;

        setProgress(completed);
        setRows(results.filter(Boolean));
      }
    }

    try {
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              CONCURRENCY,
              numbers.length
            )
          },
          () => worker()
        )
      );

      setRows(results);
    } catch {
      setError(
        "Bulk lookup stopped unexpectedly. Please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  const visibleRows = rows.filter((row) => {
    if (row.recordFound === false || row.error) {
      return showFailed;
    }

    if (
      maxFiveOnly &&
      (
        row.powerUnits === null ||
        row.powerUnits > 5
      )
    ) {
      return false;
    }

    if (
      !includeUnauthorized &&
      row.operating === "Not Authorized"
    ) {
      return false;
    }

    return true;
  });

  const successCount = rows.filter(
    (row) => row.recordFound === true && !row.error
  ).length;

  const notFoundCount = rows.filter(
    (row) => row.recordFound === false
  ).length;

  const failedCount = rows.filter(
    (row) =>
      row.recordFound === null &&
      Boolean(row.error)
  ).length;

  const eligibleCount = rows.filter(
    (row) =>
      row.recordFound === true &&
      !row.error &&
      row.powerUnits !== null &&
      row.powerUnits <= 5
  ).length;

  // Download lists use the currently visible records.
  // Only explicitly returned Authorized/Not Authorized statuses qualify.
  const authorizedRows = visibleRows.filter(
    (row) =>
      row.recordFound === true &&
      !row.error &&
      row.operating === "Authorized"
  );

  const notAuthorizedRows = visibleRows.filter(
    (row) =>
      row.recordFound === true &&
      !row.error &&
      row.operating === "Not Authorized"
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Truck size={22} />
          </div>

          <div>
            <strong>
              Carrier<span>Finder</span>
            </strong>
            <small>FMCSA LOOKUP WORKSPACE</small>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        <div className="side-item active">
          <FileSearch size={18} />
          Bulk Carrier Lookup
        </div>

        <div className="side-item muted">
          <Database size={18} />
          Data Sources
          <span className="soon">API</span>
        </div>

        <div className="sidebar-bottom">
          <div className="secure-icon">
            <ShieldCheck size={17} />
          </div>

          <strong>Official data workflow</strong>

          <p>
            Carrier data is subject to FMCSA availability
            and API limits.
          </p>

          <a
            href="https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess"
            target="_blank"
            rel="noreferrer"
          >
            API access guide <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="crumb">Workspace</span>
            <span className="slash">/</span>
            <strong>Bulk Carrier Lookup</strong>
          </div>

          <div className="top-right">
            <span className="live-dot" />
            FMCSA connector
            <span className="top-badge">LOCAL DEV</span>
          </div>
        </header>

        <section className="page-head">
          <div>
            <div className="eyebrow">
              <Activity size={14} />
              CARRIER INTELLIGENCE
            </div>

            <h1>Bulk Carrier Finder</h1>

            <p>
              Search up to 100 MC/MX docket numbers in one run.
            </p>
          </div>

          <a
            className="outline-link"
            href={SAFER_URL}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />
            Open SAFER
          </a>
        </section>

        <section className="search-panel">
          <div className="panel-title">
            <div className="title-icon">
              <Search size={19} />
            </div>

            <div>
              <h2>Bulk number input</h2>
              <p>
                Paste numbers separated by new lines, spaces,
                commas or semicolons.
              </p>
            </div>
          </div>

          <form
            onSubmit={runBulkLookup}
            className="search-form"
          >
            <label htmlFor="bulkNumbers">
              MC / MX NUMBERS — MAXIMUM 100 UNIQUE ENTRIES
            </label>

            <textarea
              id="bulkNumbers"
              className="bulk-textarea"
              value={numbersText}
              onChange={(e) =>
                setNumbersText(e.target.value)
              }
              placeholder={"MC1819001\nMX123456\nMC123457"}
              rows={7}
              disabled={busy}
            />

            <div className="input-hint">
              <span>
                <ShieldCheck size={14} />
                {numbers.length} unique number(s) detected
              </span>

              <span>5 requests at a time</span>
            </div>

            {numbersText.trim() &&
              numbersText
                .split(/[\s,;]+/)
                .filter(Boolean).length > MAX_NUMBERS && (
                <p className="validation-warning">
                  Only the first 100 unique numbers will be processed.
                </p>
              )}

            <button
              className="bulk-submit"
              type="submit"
              disabled={busy || numbers.length === 0}
            >
              {busy ? (
                <>
                  <LoaderCircle
                    className="spin"
                    size={17}
                  />
                  Searching {progress}/{numbers.length}
                </>
              ) : (
                <>
                  <Search size={17} />
                  Search all {numbers.length} numbers
                </>
              )}
            </button>
          </form>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                <span>Lookup progress</span>
                <strong>
                  {progress} / {numbers.length}
                </strong>
              </div>

              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${numbers.length
                      ? (progress / numbers.length) * 100
                      : 0
                    }%`
                  }}
                />
              </div>
            </div>
          )}
        </section>

        <section className="search-panel filter-panel">
          <div className="panel-title">
            <div className="title-icon">
              <Gauge size={19} />
            </div>

            <div>
              <h2>Result filters</h2>
              <p>
                Filters affect the table and the downloaded CSV.
              </p>
            </div>
          </div>

          <label className="filter-option">
            <input
              type="checkbox"
              checked={maxFiveOnly}
              onChange={(e) =>
                setMaxFiveOnly(e.target.checked)
              }
            />
            Show only carriers with 5 or fewer Power Units
          </label>

          <label className="filter-option">
            <input
              type="checkbox"
              checked={includeUnauthorized}
              onChange={(e) =>
                setIncludeUnauthorized(e.target.checked)
              }
            />
            Include Not Authorized carriers
          </label>

          <label className="filter-option">
            <input
              type="checkbox"
              checked={showFailed}
              onChange={(e) =>
                setShowFailed(e.target.checked)
              }
            />
            Show failed / missing records
          </label>
        </section>

        {error && (
          <div className="error-panel">
            <CircleAlert size={20} />

            <div>
              <strong>Notice</strong>
              <p>{error}</p>
            </div>

            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              <XCircle size={18} />
            </button>
          </div>
        )}

        <section className="stats-grid">
          {[
            {
              label: "Numbers processed",
              value: `${rows.length} / ${busy ? numbers.length : rows.length}`,
              icon: Search
            },
            {
              label: "Carrier records found",
              value: successCount,
              icon: CheckCircle2
            },
            {
              label: "Eligible by power units",
              value: eligibleCount,
              icon: Gauge
            },
            {
              label: "Not found / lookup errors",
              value: notFoundCount + failedCount,
              icon: CircleAlert
            }
          ].map((item) => (
            <div className="stat-card" key={item.label}>
              <div className="stat-top">
                <span>{item.label}</span>
                <item.icon size={17} />
              </div>

              <strong>{item.value}</strong>

              <small>
                Based on returned FMCSA records
              </small>
            </div>
          ))}
        </section>

        <section className="results-panel">
          <div className="results-header">
            <div>
              <div className="section-title">
                <h2>Carrier results</h2>

                <span className="response-badge">
                  <BadgeCheck size={13} />
                  {visibleRows.length} shown
                </span>
              </div>

              <p>
                {rows.length
                  ? `${successCount} records found, ${notFoundCount} not found, ${failedCount} lookup errors.`
                  : "Results will appear here after lookup."}
              </p>
            </div>

            <div className="download-actions">
              <button
                className="secondary-button"
                onClick={() =>
                  downloadCsv(
                    authorizedRows,
                    "authorized-carriers.csv"
                  )
                }
                disabled={!authorizedRows.length}
              >
                <ArrowDownToLine size={15} />
                Download Authorized
              </button>

              <button
                className="secondary-button"
                onClick={() =>
                  downloadCsv(
                    notAuthorizedRows,
                    "not-authorized-carriers.csv"
                  )
                }
                disabled={!notAuthorizedRows.length}
              >
                <ArrowDownToLine size={15} />
                Download Not Authorized
              </button>

              <button
                className="secondary-button"
                onClick={() =>
                  downloadCsv(visibleRows, "carrier-lookup-results.csv")
                }
                disabled={!visibleRows.length}
              >
                <ArrowDownToLine size={15} />
                Download All
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                {busy ? (
                  <LoaderCircle
                    className="spin"
                    size={25}
                  />
                ) : (
                  <FileSearch size={25} />
                )}
              </div>

              <strong>
                {busy
                  ? "Contacting FMCSA..."
                  : "Ready to search carriers"}
              </strong>

              <p>
                Enter up to 100 MC/MX numbers above and start the lookup.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="carrier-table">
                <thead>
                  <tr>
                    <th>MC / MX</th>
                    <th>Carrier name</th>
                    <th>Phone</th>
                    <th>USDOT</th>
                    <th>Power units</th>
                    <th>Operating status</th>
                    <th>City / State</th>
                    <th>Result</th>
                    <th>SAFER</th>
                  </tr>
                </thead>

                <tbody>
                  {visibleRows.map((row, index) => (
                    <tr key={`${row.input}-${index}`}>
                      <td>
                        {row.identifierType
                          ? `${row.identifierType}-${row.docketNumber}`
                          : row.input}
                      </td>

                      <td className="carrier-name-cell">
                        {row.name || "Not provided"}
                      </td>

                      <td>{row.phone || "—"}</td>
                      <td>{row.dotNumber || "—"}</td>
                      <td>{row.powerUnits ?? "Unknown"}</td>

                      <td>
                        <span
                          className={`status-chip ${statusClass(
                            row.operating
                          )}`}
                        >
                          {row.operating}
                        </span>
                      </td>

                      <td>
                        {[row.city, row.state]
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </td>

                      <td>
                        {row.recordFound === false ? (
                          <span
                            className="failed-label"
                            title={row.error}
                          >
                            Record Not Found
                          </span>
                        ) : row.error ? (
                          <span
                            className="failed-label"
                            title={row.error}
                          >
                            Lookup Error
                          </span>
                        ) : (
                          <span className="success-label">
                            Record Found
                          </span>
                        )}
                      </td>

                      <td>
                        <a
                          href={row.saferUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open <ArrowUpRight size={12} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {visibleRows.some((row) => row.error) && (
                <div className="result-error-list">
                  {visibleRows
                    .filter((row) => row.error)
                    .map((row, index) => (
                      <p
                        key={`${row.input}-message-${index}`}
                      >
                        <strong>{row.input}:</strong>{" "}
                        {row.error}
                      </p>
                    ))}
                </div>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div className="result-footer">
              <span>
                <CheckCircle2 size={14} />
                Showing {visibleRows.length} of {rows.length} processed records
              </span>

              <span>CSV includes visible rows only.</span>
            </div>
          )}
        </section>

        <section className="lower-grid">
          <div className="info-card">
            <div className="info-icon blue">
              <ShieldCheck size={18} />
            </div>

            <div>
              <strong>Official source workflow</strong>

              <p>
                Missing status values are not automatically treated as
                Authorized. Confirm results with official FMCSA records.
              </p>

              <a
                href="https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess"
                target="_blank"
                rel="noreferrer"
              >
                FMCSA API access <ArrowUpRight size={13} />
              </a>
            </div>
          </div>

          <div className="info-card">
            <div className="info-icon violet">
              <Database size={18} />
            </div>

            <div>
              <strong>SAFER cross-check</strong>

              <p>
                Open the official SAFER Company Snapshot to verify
                the carrier's returned details.
              </p>

              <a
                href={SAFER_URL}
                target="_blank"
                rel="noreferrer"
              >
                Company Snapshot <ArrowUpRight size={13} />
              </a>
            </div>
          </div>
        </section>

        <footer>
          <span>
            Bulk Carrier Finder{" "}
            <span className="footer-sep">•</span> Local development
          </span>

          <span>
            Data availability varies by carrier and source.
          </span>
        </footer>
      </main>
    </div>
  );
}
