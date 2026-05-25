import { jsPDF } from "jspdf";

// The receipt generator takes pre-resolved display strings. The caller
// is responsible for:
//   - `businessName` — pulled from the BUSINESS_NAME setting via the
//     branding hook (apps/web/src/lib/useBranding.ts) or pre-fetched
//     server-side
//   - `methodLabel` — resolved from the PAYMENT_METHODS taxonomy. Server
//     endpoints (e.g. /client/jobs) include this pre-resolved on the
//     payment object; worker UI resolves via usePaymentMethodLabels
//
// Keeping the receipt generator free of any taxonomy / settings lookup
// means a single rebrand or a new payment method in Settings flows
// through immediately, without code changes to the receipt PDF.
export type ReceiptData = {
  businessName: string;
  clientName: string;
  propertyAddress: string;
  jobType: string;
  serviceDate: string;
  completedDate: string;
  amount: number;
  /** Pre-resolved display label, e.g. "Venmo" — not the raw key. */
  methodLabel: string;
  workers: string[];
  receiptId: string;
};

export function generateReceiptPDF(data: ReceiptData): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 50;
  let y = 50;

  // Header
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text(data.businessName, margin, y);
  y += 12;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text("Service Receipt", margin, y);
  y += 30;

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 25;

  // Receipt details
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);

  const addRow = (label: string, value: string) => {
    doc.setFont("helvetica", "bold");
    doc.text(label, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(value, margin + 140, y);
    y += 18;
  };

  addRow("Receipt #:", data.receiptId);
  addRow("Client:", data.clientName);
  addRow("Property:", data.propertyAddress);
  addRow("Service:", data.jobType);
  addRow("Service Date:", data.serviceDate);
  addRow("Completed:", data.completedDate);
  addRow("Performed By:", data.workers.join(", ") || "—");
  addRow("Payment Method:", data.methodLabel);

  y += 10;
  doc.line(margin, y, pageWidth - margin, y);
  y += 25;

  // Amount
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Amount Paid:", margin, y);
  doc.setTextColor(0, 128, 0);
  doc.text(`$${data.amount.toFixed(2)}`, margin + 140, y);
  y += 40;

  // Footer
  doc.setTextColor(130, 130, 130);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Thank you for choosing " + data.businessName + "!", margin, y);
  y += 14;
  doc.text("If you have any questions about this receipt, please contact us.", margin, y);

  return doc;
}

export function downloadReceipt(data: ReceiptData) {
  const doc = generateReceiptPDF(data);
  doc.save(`receipt-${data.receiptId}.pdf`);
}

export function getReceiptBlob(data: ReceiptData): Blob {
  const doc = generateReceiptPDF(data);
  return doc.output("blob");
}
