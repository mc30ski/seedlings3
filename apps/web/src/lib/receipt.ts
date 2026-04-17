import { jsPDF } from "jspdf";

export type ReceiptData = {
  businessName: string;
  clientName: string;
  propertyAddress: string;
  jobType: string;
  serviceDate: string;
  completedDate: string;
  amount: number;
  method: string;
  workers: string[];
  receiptId: string;
};

const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  CHECK: "Check",
  VENMO: "Venmo",
  ZELLE: "Zelle",
  APPLE_PAY: "Apple Pay",
  CASH_APP: "Cash App",
  OTHER: "Other",
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
  addRow("Payment Method:", METHOD_LABELS[data.method] ?? data.method);

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
