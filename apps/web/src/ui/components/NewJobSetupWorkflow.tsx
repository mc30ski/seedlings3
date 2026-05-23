"use client";

import { useEffect, useRef, useState } from "react";
import { apiDelete, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ClientDialog from "@/src/ui/dialogs/ClientDialog";
import ContactDialog from "@/src/ui/dialogs/ContactDialog";
import PropertyDialog from "@/src/ui/dialogs/PropertyDialog";
import JobDialog from "@/src/ui/dialogs/JobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";

type Step = "idle" | "contact" | "client" | "property" | "job" | "occurrence" | "saving";

type EstimateDefaults = {
  occurrenceId?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  estimateAddress?: string | null;
  proposalAmount?: number | null;
  proposalNotes?: string | null;
  title?: string | null;
  estimatedMinutes?: number | null;
};

type Props = {
  active: boolean;
  onDone: () => void;
  onComplete?: (jobId?: string) => void;
  estimateDefaults?: EstimateDefaults | null;
};

export default function NewJobSetupWorkflow({ active, onDone, onComplete, estimateDefaults }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const stepRef = useRef<Step>("idle");

  function go(next: Step) {
    stepRef.current = next;
    setStep(next);
  }

  // Collected form data (deferred — not saved until the end)
  const [contactData, setContactData] = useState<any>(null);
  const [clientData, setClientData] = useState<any>(null);
  const [propertyData, setPropertyData] = useState<any>(null);
  const [jobData, setJobData] = useState<any>(null);

  function reset() {
    go("idle");
    setContactData(null);
    setClientData(null);
    setPropertyData(null);
    setJobData(null);
  }

  function handleCancel() {
    reset();
    onDone();
  }

  function closeGuard(forStep: Step) {
    return (open: boolean) => {
      if (!open && stepRef.current === forStep) {
        handleCancel();
      }
    };
  }

  useEffect(() => {
    if (active && step === "idle") {
      go("contact");
    }
  }, [active, step]);

  // Default client display name from contact first+last name
  const defaultClientName = contactData
    ? [contactData.firstName, contactData.lastName].filter(Boolean).join(" ")
    : undefined;

  // Defaults from light estimate
  const ed = estimateDefaults;
  const edNameParts = (ed?.contactName ?? "").trim().split(/\s+/);
  const edFirstName = edNameParts[0] ?? "";
  const edLastName = edNameParts.slice(1).join(" ") ?? "";
  // Parse address: "123 Main St, Austin, TX 78701"
  const edAddrParts = (ed?.estimateAddress ?? "").split(",").map((s: string) => s.trim());
  const edStreet = edAddrParts[0] ?? "";
  const edCity = edAddrParts[1] ?? "";
  const edStateZip = (edAddrParts[2] ?? "").split(/\s+/);
  const edState = edStateZip[0] ?? "";
  const edZip = edStateZip[edStateZip.length - 1] ?? "";

  // Batch save everything at the end. Heavily instrumented so failures in
  // production (or anywhere) leave a clear trail in the console + an error
  // toast that says exactly which step blew up.
  async function batchSave(occurrenceData: any) {
    go("saving");
    const log = (msg: string, extra?: unknown) =>
      // eslint-disable-next-line no-console
      console.log(`[NewJobSetup] ${msg}`, extra ?? "");
    log("Starting batchSave", { clientData, contactData, propertyData, jobData, occurrenceData });
    type Step = 1 | 2 | 3 | 4 | 5;
    let step: Step = 1;
    const stepNames: Record<Step, string> = {
      1: "Create Client",
      2: "Create Contact",
      3: "Create Property",
      4: "Create Job",
      5: "Create Occurrence",
    };
    // Track ids of every row we successfully created. On failure we use
    // these to roll back in reverse so a partial save doesn't leave
    // orphans (e.g. a stub Client with no Contact/Property when step 2
    // hits a unique-constraint violation).
    let clientId: string | null = null;
    let contactId: string | null = null;
    let propertyId: string | null = null;
    let jobId: string | null = null;

    try {
      // 1. Create client
      step = 1;
      log(`Step 1/5 → POST /api/admin/clients`, clientData);
      const client = await apiPost<{ id: string }>("/api/admin/clients", clientData);
      clientId = client.id;
      log(`Step 1/5 ✓ client.id=${client.id}`);

      // 2. Create contact for that client
      step = 2;
      log(`Step 2/5 → POST /api/admin/clients/${client.id}/contacts`, contactData);
      const contact = await apiPost<{ id: string }>(`/api/admin/clients/${client.id}/contacts`, contactData);
      contactId = contact.id;
      log(`Step 2/5 ✓ contact.id=${contact.id}`);

      // 3. Create property for that client — fix deferred references
      step = 3;
      const propPayload = { ...propertyData, clientId: client.id };
      // Replace deferred POC ID with the real contact ID
      if (propPayload.pointOfContactId === "__deferred__" || propPayload.pointOfContactId === "NONE") {
        propPayload.pointOfContactId = contact?.id ?? null;
      }
      log(`Step 3/5 → POST /api/admin/properties`, propPayload);
      const property = await apiPost<{ id: string }>("/api/admin/properties", propPayload);
      propertyId = property.id;
      log(`Step 3/5 ✓ property.id=${property.id}`);

      // 4. Create job for that property
      step = 4;
      const jobPayload = { ...jobData, propertyId: property.id };
      log(`Step 4/5 → POST /api/admin/jobs`, jobPayload);
      const job = await apiPost<{ id: string }>("/api/admin/jobs", jobPayload);
      jobId = job.id;
      log(`Step 4/5 ✓ job.id=${job.id}`);

      // 5. Create occurrence for that job
      step = 5;
      log(`Step 5/5 → POST /api/admin/jobs/${job.id}/occurrences`, occurrenceData);
      await apiPost(`/api/admin/jobs/${job.id}/occurrences`, occurrenceData);
      log(`Step 5/5 ✓ occurrence created`);

      // 6. If converting a light estimate, link it to the new job
      if (ed?.occurrenceId) {
        try {
          await apiPost(`/api/admin/occurrences/${ed.occurrenceId}/link-to-job`, { jobId: job.id });
          log(`Linked light estimate ${ed.occurrenceId} → job ${job.id}`);
        } catch (err) {
          log(`Light-estimate link failed (non-critical)`, err);
        }
      }

      log(`batchSave complete — job.id=${job.id}`);
      publishInlineMessage({ type: "SUCCESS", text: "New job setup complete!" });
      reset();
      onDone();
      onComplete?.(job.id);
    } catch (err: any) {
      const stepName = stepNames[step];
      // eslint-disable-next-line no-console
      console.error(`[NewJobSetup] FAILED at step ${step}/5 (${stepName}):`, err);
      const inner = getErrorMessage("(no details)", err);

      // Roll back any rows we already created so failure doesn't leave
      // orphan Clients/Properties/etc. cluttering production. Reverse
      // order matches FK cascade direction — children before parents.
      // Each delete is best-effort: if it 403s (permissions), 404s
      // (already gone), or otherwise fails, log and move on. We're not
      // going to bubble a rollback error over the original cause.
      const tryDelete = async (path: string, label: string) => {
        try {
          await apiDelete(path);
          log(`Rollback ✓ deleted ${label}`);
        } catch (delErr) {
          log(`Rollback ✗ failed to delete ${label} (cleanup may be needed)`, delErr);
        }
      };
      const rolledBack: string[] = [];
      if (jobId) { await tryDelete(`/api/admin/jobs/${jobId}`, `job ${jobId}`); rolledBack.push("job"); }
      if (propertyId) { await tryDelete(`/api/admin/properties/${propertyId}`, `property ${propertyId}`); rolledBack.push("property"); }
      if (contactId && clientId) { await tryDelete(`/api/admin/clients/${clientId}/contacts/${contactId}`, `contact ${contactId}`); rolledBack.push("contact"); }
      if (clientId) { await tryDelete(`/api/admin/clients/${clientId}`, `client ${clientId}`); rolledBack.push("client"); }

      const rollbackNote = rolledBack.length > 0
        ? ` (rolled back ${rolledBack.join(", ")})`
        : "";
      publishInlineMessage({
        type: "ERROR",
        text: `Setup failed at step ${step}/5 (${stepName}): ${inner}.${rollbackNote} Check the browser console for the full error.`,
      });
      reset();
      onDone();
    }
  }

  return (
    <>
      {/* Step 1: Collect Contact info (deferred) */}
      {step === "contact" && (
        <ContactDialog
          open
          onOpenChange={closeGuard("contact")}
          mode="CREATE"
          role="ADMIN"
          clientId="__deferred__"
          preventOutsideClose
          deferSave
          defaultIsPrimary
          initial={contactData ?? (ed ? { firstName: edFirstName, lastName: edLastName, phone: ed.contactPhone, email: ed.contactEmail, isPrimary: true, role: "OWNER" } as any : undefined)}
          onSaved={(data) => {
            setContactData(data);
            go("client");
          }}
        />
      )}

      {/* Step 2: Collect Client info (deferred, pre-populated with contact name) */}
      {step === "client" && (
        <ClientDialog
          open
          onOpenChange={closeGuard("client")}
          mode="CREATE"
          role="ADMIN"
          preventOutsideClose
          deferSave
          defaultDisplayName={clientData?.displayName ?? defaultClientName}
          initial={clientData ?? undefined}
          onBack={() => go("contact")}
          onSaved={(data) => {
            setClientData(data);
            go("property");
          }}
        />
      )}

      {/* Step 3: Collect Property info (deferred) */}
      {step === "property" && (
        <PropertyDialog
          open
          onOpenChange={closeGuard("property")}
          mode="CREATE"
          role="ADMIN"
          preventOutsideClose
          deferSave
          deferredClient={clientData ? { id: "__deferred__", displayName: clientData.displayName } : undefined}
          deferredContact={contactData ? { firstName: contactData.firstName, lastName: contactData.lastName, email: contactData.email, phone: contactData.phone } : undefined}
          defaultClientId="__deferred__"
          initial={propertyData ?? (ed ? { displayName: "Main House", street1: edStreet, city: edCity, state: edState, postalCode: edZip, estimateAddress: ed.estimateAddress } as any : undefined)}
          onBack={() => go("client")}
          onSaved={(data) => {
            setPropertyData(data);
            go("job");
          }}
        />
      )}

      {/* Step 4: Collect Job info (deferred) */}
      {step === "job" && (
        <JobDialog
          open
          onOpenChange={closeGuard("job")}
          mode="CREATE"
          preventOutsideClose
          deferSave
          deferredProperty={propertyData ? { id: "__deferred__", displayName: propertyData.displayName } : undefined}
          defaultPropertyId="__deferred__"
          initial={jobData ?? (ed ? { defaultPrice: ed.proposalAmount, notes: ed.proposalNotes, estimatedMinutes: ed.estimatedMinutes, frequencyDays: 14 } as any : { frequencyDays: 14 } as any)}
          onBack={() => go("property")}
          onSaved={(data) => {
            setJobData(data);
            go("occurrence");
          }}
        />
      )}

      {/* Step 5: Collect Occurrence info then batch save everything */}
      {step === "occurrence" && (
        <OccurrenceDialog
          open
          onOpenChange={closeGuard("occurrence")}
          mode="CREATE"
          jobId="__deferred__"
          isAdmin
          preventOutsideClose
          defaultPrice={jobData?.defaultPrice}
          defaultEstimatedMinutes={jobData?.estimatedMinutes}
          defaultNotes={jobData?.notes}
          defaultWorkflow={ed ? "STANDARD" : undefined}
          jobFrequencyDays={jobData?.frequencyDays != null ? Number(jobData.frequencyDays) : null}
          title="New Occurrence (Final Step)"
          submitLabel="Create Everything"
          deferSave
          onBack={() => go("job")}
          onSaved={(data) => {
            void batchSave(data);
          }}
        />
      )}

      {/* Saving indicator */}
      {step === "saving" && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 99999,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.3)",
        }}>
          <div style={{
            background: "white", padding: "24px 32px", borderRadius: "12px",
            fontSize: "14px", fontWeight: 600,
          }}>
            Creating everything...
          </div>
        </div>
      )}
    </>
  );
}
