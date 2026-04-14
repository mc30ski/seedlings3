"use client";

import { useEffect, useRef, useState } from "react";
import { apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ClientDialog from "@/src/ui/dialogs/ClientDialog";
import ContactDialog from "@/src/ui/dialogs/ContactDialog";
import PropertyDialog from "@/src/ui/dialogs/PropertyDialog";
import JobDialog from "@/src/ui/dialogs/JobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";

type Step = "idle" | "contact" | "client" | "property" | "job" | "occurrence" | "saving";

type Props = {
  active: boolean;
  onDone: () => void;
  onComplete?: (jobId?: string) => void;
};

export default function NewJobSetupWorkflow({ active, onDone, onComplete }: Props) {
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

  // Batch save everything at the end
  async function batchSave(occurrenceData: any) {
    go("saving");
    try {
      // 1. Create client
      const client = await apiPost<{ id: string }>("/api/admin/clients", clientData);

      // 2. Create contact for that client
      const contact = await apiPost<{ id: string }>(`/api/admin/clients/${client.id}/contacts`, contactData);

      // 3. Create property for that client — fix deferred references
      const propPayload = { ...propertyData, clientId: client.id };
      // Replace deferred POC ID with the real contact ID
      if (propPayload.pointOfContactId === "__deferred__" || propPayload.pointOfContactId === "NONE") {
        propPayload.pointOfContactId = contact?.id ?? null;
      }
      const property = await apiPost<{ id: string }>("/api/admin/properties", propPayload);

      // 4. Create job for that property
      const job = await apiPost<{ id: string }>("/api/admin/jobs", {
        ...jobData,
        propertyId: property.id,
      });

      // 5. Create occurrence for that job
      await apiPost(`/api/admin/jobs/${job.id}/occurrences`, occurrenceData);

      publishInlineMessage({ type: "SUCCESS", text: "New job setup complete!" });
      reset();
      onDone();
      onComplete?.(job.id);
    } catch (err: any) {
      console.error("NewJobSetupWorkflow batch save failed:", err);
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Setup failed. Some items may have been partially created.", err) });
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
          defaultDisplayName={defaultClientName}
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
          title="New Occurrence (Final Step)"
          submitLabel="Create Everything"
          deferSave
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
