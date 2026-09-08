// Unit tests for the Gusto Payroll Journal adapter.
//
// The fixture is the operator's REAL export, byte for byte
// (__fixtures__/gusto-payroll-journal.csv). Every assertion about specific
// numbers below was read off that file — if Gusto changes shape, these
// fail and the change is a deliberate one.
//
// Spec: docs/features/payroll.md.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseCsv,
  parseMoneyCell,
  parseGustoPayrollJournal,
  checkConservation,
  PayrollParseError,
} from "./payrollImport";

const FIXTURE = readFileSync(
  join(__dirname, "__fixtures__", "gusto-payroll-journal.csv"),
  "utf8",
);

describe("parseCsv", () => {
  it("keeps commas inside quoted fields together", () => {
    // The exact reason split(",") is not an option: the real Work Address
    // column contains two commas inside its quotes.
    const rows = parseCsv('"a","225 Stony Branch Trl, Chapel Hill, NC 27516","c"');
    expect(rows[0]).toEqual(["a", "225 Stony Branch Trl, Chapel Hill, NC 27516", "c"]);
  });

  it("handles escaped quotes", () => {
    expect(parseCsv('"say ""hi""","b"')[0]).toEqual(['say "hi"', "b"]);
  });

  it("handles embedded newlines inside quotes", () => {
    const rows = parseCsv('"line1\nline2","b"');
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("line1\nline2");
  });

  it("handles CRLF", () => {
    expect(parseCsv('"a","b"\r\n"c","d"')).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not emit a phantom row for a trailing newline", () => {
    expect(parseCsv('"a","b"\n')).toHaveLength(1);
  });

  it("preserves empty fields", () => {
    expect(parseCsv('"a","","c"')[0]).toEqual(["a", "", "c"]);
  });
});

describe("parseMoneyCell", () => {
  it("treats blank as null, NOT zero", () => {
    // Load-bearing. Caleb's Regular (Hours) is "" while his Gross is "0.00";
    // Jacob's FUTA is "" while Justin's is "3.38". Blank means "not
    // applicable", 0.00 means "computed to zero".
    expect(parseMoneyCell("")).toBeNull();
    expect(parseMoneyCell("   ")).toBeNull();
  });

  it('treats "0.00" as zero, NOT null', () => {
    expect(parseMoneyCell("0.00")).toBe(0);
  });

  it("parses ordinary amounts", () => {
    expect(parseMoneyCell("563.79")).toBe(563.79);
    expect(parseMoneyCell("17.25")).toBe(17.25);
  });

  it("tolerates separators and currency symbols", () => {
    expect(parseMoneyCell("$1,290.08")).toBe(1290.08);
  });

  it("reads parenthesised values as negative", () => {
    expect(parseMoneyCell("(45.23)")).toBe(-45.23);
  });

  it("throws on non-numeric text rather than silently returning 0", () => {
    expect(() => parseMoneyCell("N/A")).toThrow();
    expect(() => parseMoneyCell("--")).toThrow();
  });
});

describe("parseGustoPayrollJournal — real export", () => {
  const [period] = parseGustoPayrollJournal(FIXTURE);

  it("finds exactly one period", () => {
    expect(parseGustoPayrollJournal(FIXTURE)).toHaveLength(1);
  });

  it("reads the period and pay day, tolerating Gusto's leading spaces", () => {
    expect(period.periodStart).toBe("2026-08-10");
    expect(period.periodEnd).toBe("2026-08-16");
    expect(period.payDay).toBe("2026-08-21");
  });

  it('strips "payroll period" from the label', () => {
    expect(period.label).toBe("Weekly Payroll");
  });

  it("excludes the Payroll Totals row from employees", () => {
    expect(period.entries).toHaveLength(3);
    expect(period.entries.map((e) => e.rawLastName)).toEqual([
      "Serrano",
      "Torres",
      "Wanderski",
    ]);
  });

  it("captures identity and metadata columns", () => {
    const justin = period.entries[1];
    expect(justin.rawFirstName).toBe("Justin");
    expect(justin.employeeType).toBe("Paid by the hour");
    expect(justin.paymentMethod).toBe("Direct Deposit");
    expect(justin.workAddress).toBe("225 Stony Branch Trl, Chapel Hill, NC 27516");
  });

  it("maps every money column for a fully-populated worker", () => {
    const justin = period.entries[1];
    expect(justin.values).toMatchObject({
      regularHours: 17.25,
      regularRate: 7.25,
      regularAmount: 125.06,
      additionalEarnings: 438.73,
      grossEarnings: 563.79,
      employeeTaxes: 81.85,
      federalIncomeTax: 25.73,
      socialSecurityEmployee: 34.95,
      medicareEmployee: 8.17,
      additionalMedicareEmployee: 0,
      stateTaxEmployee: 13.0,
      employerTaxes: 52.14,
      socialSecurityEmployer: 34.95,
      medicareEmployer: 8.17,
      futaEmployer: 3.38,
      stateUnemploymentEmployer: 5.64,
      netPay: 481.94,
      reimbursements: 0,
      donations: 0,
      checkAmount: 481.94,
      employerCost: 615.93,
    });
  });

  it("does not confuse Medicare with Additional Medicare", () => {
    // Adjacent columns whose names are prefixes of one another — a
    // substring match here would silently overwrite one with the other.
    const jacob = period.entries[2];
    expect(jacob.values.medicareEmployee).toBe(10.53);
    expect(jacob.values.additionalMedicareEmployee).toBe(0);
  });

  it("maps the NC-specific tax columns by pattern", () => {
    const justin = period.entries[1];
    expect(justin.values.stateTaxEmployee).toBe(13.0);
    expect(justin.values.stateUnemploymentEmployer).toBe(5.64);
  });

  it("still maps state columns when the state is not NC", () => {
    // The first out-of-state hire must not silently drop a tax column.
    const sc = FIXTURE.replace(/NC State Tax \(Employee\)/, "SC State Tax (Employee)")
      .replace(/NC Unemployment Tax \(Employer\)/, "SC Unemployment Tax (Employer)");
    const [p] = parseGustoPayrollJournal(sc);
    expect(p.entries[1].values.stateTaxEmployee).toBe(13.0);
    expect(p.entries[1].values.stateUnemploymentEmployer).toBe(5.64);
  });

  it("preserves blank vs zero on the zero-hours worker", () => {
    // Caleb is on payroll but worked nothing this period.
    const caleb = period.entries[0];
    expect(caleb.values.regularHours).toBeNull();
    expect(caleb.values.regularRate).toBeNull();
    expect(caleb.values.grossEarnings).toBe(0);
    expect(caleb.values.netPay).toBe(0);
  });

  it("preserves a blank employer-tax cell as null, not zero", () => {
    // Jacob has no FUTA line; Justin does. If both read as 0 we could no
    // longer tell "no FUTA owed" from "FUTA of zero".
    expect(period.entries[2].values.futaEmployer).toBeNull();
    expect(period.entries[2].values.stateUnemploymentEmployer).toBeNull();
    expect(period.entries[1].values.futaEmployer).toBe(3.38);
  });

  it("keeps the complete source row verbatim in raw", () => {
    const justin = period.entries[1];
    expect(justin.raw["NC State Tax (Employee)"]).toBe("13.00");
    expect(justin.raw["Gross Earnings"]).toBe("563.79");
    // Blank stays blank in raw — raw is the file, not our interpretation.
    expect(period.entries[0].raw["Regular (Hours)"]).toBe("");
    expect(Object.keys(justin.raw)).toHaveLength(period.headers.length);
  });

  it("parses the totals row", () => {
    expect(period.totals.values.grossEarnings).toBe(1290.08);
    expect(period.totals.values.netPay).toBe(1087.44);
    expect(period.totals.values.employerCost).toBe(1397.78);
  });
});

describe("checkConservation", () => {
  it("passes on the real export", () => {
    const [period] = parseGustoPayrollJournal(FIXTURE);
    expect(checkConservation(period)).toEqual([]);
  });

  it("does NOT sum the rate column", () => {
    // Two workers at 7.25/hr; Gusto reports 7.25 in totals, not 14.50.
    // Treating rate as additive would reject every legitimate upload.
    const [period] = parseGustoPayrollJournal(FIXTURE);
    const summedRate = period.entries.reduce((a, e) => a + (e.values.regularRate ?? 0), 0);
    expect(summedRate).toBeCloseTo(14.5, 2);
    expect(period.totals.values.regularRate).toBe(7.25);
    expect(checkConservation(period).map((m) => m.field)).not.toContain("regularRate");
  });

  it("catches a tampered amount", () => {
    const tampered = FIXTURE.replace('"563.79"', '"563.78"');
    const [period] = parseGustoPayrollJournal(tampered);
    const bad = checkConservation(period);
    expect(bad.length).toBeGreaterThan(0);
    const gross = bad.find((m) => m.field === "grossEarnings");
    expect(gross).toBeDefined();
    expect(gross!.header).toBe("Gross Earnings");
    expect(gross!.reported).toBe(1290.08);
    expect(gross!.summed).toBe(1290.07);
  });

  it("catches a dropped employee row (truncated file)", () => {
    const truncated = FIXTURE.split("\n")
      .filter((l) => !l.startsWith('"Torres"'))
      .join("\n");
    const [period] = parseGustoPayrollJournal(truncated);
    expect(period.entries).toHaveLength(2);
    expect(checkConservation(period).length).toBeGreaterThan(0);
  });

  it("tolerates sub-cent drift but still catches a one-cent error", () => {
    // Money is Float here (matching Payment.amountPaid), so summing many
    // rows can land fractions of a cent away from Gusto's total. The
    // comparison is at cent precision: below half a cent passes, a real
    // cent fails. Asserted as a boundary rather than a claim about any
    // particular pair of numbers.
    const [ok] = parseGustoPayrollJournal(FIXTURE);
    expect(checkConservation(ok)).toEqual([]);

    // 0.001 off — below the half-cent threshold, still clean.
    const drifted = FIXTURE.replace('"1290.08"', '"1290.081"');
    const [d] = parseGustoPayrollJournal(drifted);
    expect(checkConservation(d).map((m) => m.field)).not.toContain("grossEarnings");

    // A full cent off — reported.
    const wrong = FIXTURE.replace('"1290.08"', '"1290.09"');
    const [w] = parseGustoPayrollJournal(wrong);
    expect(checkConservation(w).map((m) => m.field)).toContain("grossEarnings");
  });
});

describe("parseGustoPayrollJournal — failure modes", () => {
  it("rejects a file with no Employee Earnings section", () => {
    expect(() => parseGustoPayrollJournal('"Some Other Report"\n"a","b"')).toThrow(
      PayrollParseError,
    );
  });

  it("rejects a section missing its totals row", () => {
    const noTotals = FIXTURE.split("\n")
      .filter((l) => !l.startsWith('"Payroll Totals"'))
      .join("\n");
    expect(() => parseGustoPayrollJournal(noTotals)).toThrow(/truncated/i);
  });

  it("rejects a section with no pay day line", () => {
    const noPayDay = FIXTURE.split("\n")
      .filter((l) => !l.startsWith('"Pay day"'))
      .join("\n");
    expect(() => parseGustoPayrollJournal(noPayDay)).toThrow(/pay day/i);
  });

  it("rejects a section with no period line", () => {
    const noPeriod = FIXTURE.split("\n")
      .filter((l) => !/payroll period/.test(l))
      .join("\n");
    expect(() => parseGustoPayrollJournal(noPeriod)).toThrow(/period/i);
  });

  it("rejects a section with no employee rows", () => {
    const empty = FIXTURE.split("\n")
      .filter((l) => !/^"(Serrano|Torres|Wanderski)"/.test(l))
      .join("\n");
    expect(() => parseGustoPayrollJournal(empty)).toThrow(/no employee rows/i);
  });

  it("parses BOTH sections when a journal has two pay schedules", () => {
    // Companies running weekly + bi-weekly export one file with two
    // sections. Taking only the first would silently drop people's pay.
    const second = FIXTURE.slice(FIXTURE.indexOf('"Employee Earnings"'))
      .replace(" 08/10/2026 - 08/16/2026", " 08/17/2026 - 08/23/2026")
      .replace(" 08/21/2026", " 08/28/2026")
      .replace("Weekly Payroll payroll period", "Bi-weekly Payroll payroll period");
    const periods = parseGustoPayrollJournal(FIXTURE + "\n" + second);
    expect(periods).toHaveLength(2);
    expect(periods[0].periodStart).toBe("2026-08-10");
    expect(periods[1].periodStart).toBe("2026-08-17");
    expect(periods[1].payDay).toBe("2026-08-28");
    expect(periods[1].label).toBe("Bi-weekly Payroll");
    expect(periods[1].entries).toHaveLength(3);
    expect(checkConservation(periods[1])).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Paycheck Tips — the column Gusto added, and the class of failure it exposed.
//
// It arrived the first time a payroll period carried tips: INSERTED ahead of
// Gross Earnings rather than appended. The parser maps by header NAME, so
// nothing misaligned and nothing broke. It simply had no mapping, was read,
// and was dropped. The import reported success, every figure reconciled
// against Gusto's own totals row, and the money appeared on no screen in the
// application. The operator found it by noticing an absence.
// ─────────────────────────────────────────────────────────────────────────────

const TIPPED_CSV = [
  '"Payroll Journal Report"',
  "",
  '"Seedlings Lawn Care, LLC"',
  "",
  '"Employee Earnings"',
  '"Weekly Payroll payroll period"," 08/31/2026 - 09/06/2026"',
  '"Pay day"," 09/11/2026"',
  '"Last Name","First Name","Work Address","Employee Type","Payment","Regular (Hours)","Regular (Rate)","Regular (Amount)","Additional Earnings","Paycheck Tips","Gross Earnings","Employee Taxes","Federal Income Tax (Employee)","Social Security (Employee)","Medicare (Employee)","Additional Medicare (Employee)","NC State Tax (Employee)","Employer Taxes","Social Security (Employer)","Medicare (Employer)","FUTA (Employer)","NC Unemployment Tax (Employer)","Net Pay","Reimbursements","Donations","Check Amount","Employer Cost"',
  '"Serrano","Caleb","225 Stony Branch Trl, Chapel Hill, NC 27516","Paid by the hour","Direct Deposit","2.27","7.25","16.46","51.79","10.50","78.75","6.03","0.00","4.88","1.15","0.00","0.00","7.29","4.88","1.15","0.47","0.79","72.72","0.00","0.00","72.72","86.04"',
  '"Torres","Justin","225 Stony Branch Trl, Chapel Hill, NC 27516","Paid by the hour","Direct Deposit","5.91","7.25","42.85","134.27","","177.12","13.55","0.00","10.98","2.57","0.00","0.00","16.38","10.98","2.57","1.06","1.77","163.57","0.00","0.00","163.57","193.50"',
  '"Wanderski","Jacob","225 Stony Branch Trl, Chapel Hill, NC 27516","Paid by the hour","Direct Deposit","8.47","7.25","61.41","222.96","10.50","294.87","24.57","0.00","18.29","4.28","0.00","2.00","22.57","18.29","4.28","","","270.30","0.00","0.00","270.30","317.44"',
  '"Payroll Totals","","","","","16.65","7.25","120.72","409.02","21.00","550.74","44.15","0.00","34.15","8.00","0.00","2.00","46.24","34.15","8.00","1.53","2.56","506.59","0.00","0.00","506.59","596.98"',
].join("\n");

describe("Paycheck Tips", () => {
  it("is read, not dropped", () => {
    const p = parseGustoPayrollJournal(TIPPED_CSV)[0];
    const byName = Object.fromEntries(p.entries.map((e) => [e.rawLastName, e]));
    expect(byName.Serrano.values.paycheckTips).toBe(10.5);
    expect(byName.Wanderski.values.paycheckTips).toBe(10.5);
    expect(p.totals.values.paycheckTips).toBe(21);
  });

  it("keeps a blank tips cell NULL, not zero", () => {
    // Justin's cell is "". Collapsing that to 0 asserts Gusto computed a zero
    // tip for him, which it did not — the same rule that governs every other
    // column here.
    const p = parseGustoPayrollJournal(TIPPED_CSV)[0];
    const justin = p.entries.find((e) => e.rawLastName === "Torres")!;
    expect(justin.values.paycheckTips).toBeNull();
  });

  it("does not disturb the columns Gusto inserted it in front of", () => {
    // Inserted ahead of Gross Earnings. A positional parser would shift every
    // column after it; this one maps by name.
    const p = parseGustoPayrollJournal(TIPPED_CSV)[0];
    const caleb = p.entries.find((e) => e.rawLastName === "Serrano")!;
    expect(caleb.values.grossEarnings).toBe(78.75);
    expect(caleb.values.additionalEarnings).toBe(51.79);
    expect(caleb.values.netPay).toBe(72.72);
    expect(caleb.values.employerCost).toBe(86.04);
  });

  it("is a COMPONENT of gross, never an addition to it", () => {
    // 16.46 regular + 51.79 additional + 10.50 tips = 78.75 gross.
    const p = parseGustoPayrollJournal(TIPPED_CSV)[0];
    const c = p.entries.find((e) => e.rawLastName === "Serrano")!.values;
    const parts = (c.regularAmount ?? 0) + (c.additionalEarnings ?? 0) + (c.paycheckTips ?? 0);
    expect(Math.round(parts * 100) / 100).toBe(c.grossEarnings);
  });

  it("is covered by the conservation check", () => {
    // A wrong tip total must be refused before anything is written, like any
    // other additive column.
    const bad = TIPPED_CSV.replace('"409.02","21.00"', '"409.02","99.00"');
    const p = parseGustoPayrollJournal(bad)[0];
    const mismatches = checkConservation(p);
    expect(mismatches.map((m) => m.field)).toContain("paycheckTips");
  });

  it("reports a numeric column it cannot map, and ignores a text one", () => {
    // THE SYSTEMIC HALF. A column with no mapping used to vanish in silence.
    const withUnknown = TIPPED_CSV
      .replace('"Paycheck Tips",', '"Paycheck Tips","Holiday Bonus","Uniform Note",')
      .replace('"10.50","78.75"', '"10.50","25.00","issued","78.75"')
      .replace('"","177.12"', '"","25.00","issued","177.12"')
      .replace('"10.50","294.87"', '"10.50","25.00","issued","294.87"')
      .replace('"21.00","550.74"', '"21.00","75.00","","550.74"');
    const p = parseGustoPayrollJournal(withUnknown)[0];
    expect(p.unmappedNumericHeaders).toContain("Holiday Bonus");
    expect(p.unmappedNumericHeaders).not.toContain("Uniform Note");
    // …and a file we fully understand reports nothing.
    expect(parseGustoPayrollJournal(TIPPED_CSV)[0].unmappedNumericHeaders).toEqual([]);
  });
});
