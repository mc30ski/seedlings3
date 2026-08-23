import { jsPDF } from "jspdf";
import { fmtDateLong } from "@/src/lib/dates";

// Client-facing "Statement" PDF generator.
//
// Renders the payload returned by GET /api/client/statement into a
// printable single-property statement suitable for a client to hand to
// their accountant. Companion to receipt.ts (single-payment receipt);
// this one lists MANY payments over a date range.
//
// Client-visibility contract: the payload from /client/statement is
// already scoped to safe fields only — the layer that generates this
// PDF must NEVER pull additional data from any other client endpoint.
// If a field isn't in `StatementData`, it doesn't belong on the page.

export type StatementRow = {
  /** Same rule as the Service Receipt PDF's Receipt #: last 8 chars
   *  of the occurrence id, uppercased. Lets the client match a line
   *  on the statement against a previously-downloaded receipt. */
  receiptId: string;
  serviceDate: string; // YYYY-MM-DD (ET calendar day)
  paymentDate: string; // YYYY-MM-DD
  description: string;
  method: string;
  amount: number;
};

export type StatementData = {
  business: {
    name: string;
    ein: string;
    address: string;
    phone: string;
    email: string;
    /** Optional PNG data URL of the business logo. When present the
     *  generator draws it in the top-left of the header, shifting the
     *  business-name text to the right. Fetched by the download wrapper
     *  from a public asset so the pure generator stays sync. */
    logoDataUrl?: string | null;
  };
  client: {
    name: string;
    contact: string;
    email: string;
    phone: string;
  };
  property: {
    displayName: string;
    address: string;
  };
  period: { from: string; to: string }; // YYYY-MM-DD
  rows: StatementRow[];
  total: number;
};

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function generateStatementPDF(data: StatementData): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 50;
  let y = 50;

  // ── Header: logo (optional) + business name + tagline ────────────────
  // Logo sits top-left, business name to its right. When no logo, name
  // starts at the left margin as before.
  const logoSize = 32;
  const hasLogo = !!data.business.logoDataUrl;
  if (hasLogo) {
    try {
      doc.addImage(data.business.logoDataUrl!, "PNG", margin, y - logoSize + 8, logoSize, logoSize);
    } catch {
      // If the data URL is malformed jsPDF throws — swallow so the
      // statement still renders without the logo rather than failing
      // the whole download.
    }
  }
  const textX = hasLogo ? margin + logoSize + 12 : margin;
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text(data.business.name || "Statement", textX, y);
  y += 14;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text("Statement of Services", textX, y);
  y += hasLogo ? Math.max(24, logoSize - 14) : 24;

  // ── Business info block (right-aligned under header) ─────────────────
  const bizLines: string[] = [];
  if (data.business.address) bizLines.push(data.business.address);
  if (data.business.phone) bizLines.push(data.business.phone);
  if (data.business.email) bizLines.push(data.business.email);
  if (data.business.ein) bizLines.push(`EIN: ${data.business.ein}`);
  const bizStartY = 50;
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  bizLines.forEach((line, i) => {
    doc.text(line, pageWidth - margin, bizStartY + i * 12, { align: "right" });
  });
  // Reset text color for body
  doc.setTextColor(0, 0, 0);

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 20;

  // ── Client + property block ──────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("For", margin, y);
  doc.text("Property", margin + 260, y);
  y += 14;
  doc.setFont("helvetica", "normal");

  const clientLines = [
    data.client.name,
    data.client.contact,
    data.client.email,
    data.client.phone,
  ].filter(Boolean);
  const propLines = [
    data.property.displayName,
    data.property.address,
  ].filter(Boolean);
  const blockHeight = Math.max(clientLines.length, propLines.length) * 12;
  clientLines.forEach((line, i) => doc.text(line, margin, y + i * 12));
  propLines.forEach((line, i) => doc.text(line, margin + 260, y + i * 12));
  y += blockHeight + 18;

  // ── Period + total callout ───────────────────────────────────────────
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 16;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(
    `Period: ${fmtDateLong(data.period.from)} — ${fmtDateLong(data.period.to)}`,
    margin,
    y,
  );
  doc.text(`Total: ${fmtUSD(data.total)}`, pageWidth - margin, y, { align: "right" });
  y += 22;

  // ── Line-item table ──────────────────────────────────────────────────
  // Columns: Receipt # | Service Date | Payment Date | Description | Method | Amount
  // Fixed widths tuned for letter-portrait with a 50pt margin.
  const cols = [
    { label: "Receipt #", x: margin, width: 62, align: "left" as const },
    { label: "Service", x: margin + 62, width: 60, align: "left" as const },
    { label: "Payment", x: margin + 122, width: 60, align: "left" as const },
    { label: "Description", x: margin + 182, width: 180, align: "left" as const },
    { label: "Method", x: margin + 362, width: 56, align: "left" as const },
    { label: "Amount", x: pageWidth - margin, width: 70, align: "right" as const },
  ];

  function drawHeaderRow() {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setFillColor(240, 240, 240);
    doc.rect(margin, y - 12, pageWidth - 2 * margin, 16, "F");
    cols.forEach((c) => doc.text(c.label, c.x, y, { align: c.align }));
    y += 8;
    doc.setDrawColor(180, 180, 180);
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
  }
  drawHeaderRow();

  if (data.rows.length === 0) {
    doc.setTextColor(120, 120, 120);
    doc.setFont("helvetica", "italic");
    doc.text("No payments in this period.", margin, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    y += 20;
  } else {
    for (const row of data.rows) {
      // Page-break guard — leave room for footer.
      if (y > pageHeight - 100) {
        doc.addPage();
        y = 50;
        drawHeaderRow();
      }
      const cells = [
        row.receiptId,
        row.serviceDate,
        row.paymentDate,
        row.description,
        row.method,
        fmtUSD(row.amount),
      ];
      cells.forEach((cell, i) => {
        const c = cols[i];
        // Truncate description column (index 3) if too wide — jsPDF
        // has no auto-wrap on plain text, so a naive splitTextToSize
        // keeps the row on one line. Anything past ~34 chars gets
        // ellipsized to fit the narrower slot.
        const text = i === 3 && cell.length > 34 ? cell.slice(0, 31) + "…" : cell;
        doc.text(text, c.x, y, { align: c.align });
      });
      y += 16;
    }
  }

  // ── Total row (bottom of table) ──────────────────────────────────────
  y += 6;
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y, pageWidth - margin, y);
  y += 14;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Total", margin + 362, y, { align: "left" });
  doc.text(fmtUSD(data.total), pageWidth - margin, y, { align: "right" });
  y += 30;

  // ── Disclaimer footer ────────────────────────────────────────────────
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  const disclaimer =
    `This statement reflects payments received and confirmed by ${data.business.name || "the business"} for services at ` +
    `${data.property.displayName || "this property"} during the selected period. Payments are grouped by the date the ` +
    `payment was confirmed (cash basis). Consult your tax professional for how to categorize these expenses on your return.`;
  const wrapped = doc.splitTextToSize(disclaimer, pageWidth - 2 * margin);
  doc.text(wrapped, margin, pageHeight - 60);

  return doc;
}

function filename(data: StatementData): string {
  const safeProp = (data.property.displayName || "statement").replace(/[^a-zA-Z0-9]+/g, "-");
  return `statement_${safeProp}_${data.period.from}_to_${data.period.to}.pdf`;
}

/** Generate + trigger download of the statement PDF. Sync — the
 *  caller passes `data.business.logoDataUrl` already populated (see
 *  useLogoDataUrl hook). */
export function downloadStatementPDF(data: StatementData): void {
  const doc = generateStatementPDF(data);
  doc.save(filename(data));
}

/** Sync blob export mirroring `getReceiptBlob`. Used by the "View"
 *  button so window.open can fire inside the user gesture without
 *  running afoul of mobile popup blockers. */
export function getStatementBlob(data: StatementData): Blob {
  const doc = generateStatementPDF(data);
  return doc.output("blob");
}
