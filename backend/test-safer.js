
const response = await fetch(
  "https://safer.fmcsa.dot.gov/query.asp",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      searchtype: "ANY",
      query_type: "queryCarrierSnapshot",
      query_param: "MC_MX",
      query_string: "1819011",
    }),
  }
);

const html = await response.text();

for (const term of [
  "AFG EX BROS LLC",
  "USDOT Status:",
  "Operating Authority Status",
  "Authority Status",
  "AUTHORIZED FOR",
  "Power Units:",
  "Total Drivers:",
]) {
  const regex = new RegExp(
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi"
  );

  let match;
  let count = 0;

  while ((match = regex.exec(html)) !== null && count < 3) {
    console.log(`\n--- ${term} ---`);
    console.log(
      html.slice(
        Math.max(0, match.index - 150),
        Math.min(html.length, match.index + 500)
      )
    );
    count++;
  }
}
