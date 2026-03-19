"use client";

import { useEffect, useRef, useState } from "react";
import ClientDialog from "@/src/ui/dialogs/ClientDialog";
import ContactDialog from "@/src/ui/dialogs/ContactDialog";
import PropertyDialog from "@/src/ui/dialogs/PropertyDialog";
import JobDialog from "@/src/ui/dialogs/JobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";

type Step = "idle" | "client" | "contact" | "property" | "job" | "occurrence";

type Props = {
  active: boolean;
  onDone: () => void;
};

export default function NewJobSetupWorkflow({ active, onDone }: Props) {
  const [step, setStep] = useState<Step>("idle");

  // stepRef is updated synchronously so close handlers can tell
  // whether onSaved already advanced past their step.
  const stepRef = useRef<Step>("idle");

  function go(next: Step) {
    stepRef.current = next;
    setStep(next);
  }

  const [clientId, setClientId] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobDefaults, setJobDefaults] = useState<{
    defaultPrice?: number | null;
    notes?: string | null;
    frequencyDays?: number | null;
  }>({});

  function reset() {
    go("idle");
    setClientId(null);
    setPropertyId(null);
    setJobId(null);
    setJobDefaults({});
  }

  function handleCancel() {
    reset();
    onDone();
  }

  // Only treat close as cancel if the step hasn't already advanced.
  // The dialog's finally block calls onOpenChange(false) after onSaved,
  // but by then stepRef has already moved to the next step.
  function closeGuard(forStep: Step) {
    return (open: boolean) => {
      if (!open && stepRef.current === forStep) {
        handleCancel();
      }
    };
  }

  useEffect(() => {
    if (active && step === "idle") {
      go("client");
    }
  }, [active, step]);

  return (
    <>
      {/* Step 1: Create Client */}
      {step === "client" && (
        <ClientDialog
          open
          onOpenChange={closeGuard("client")}
          mode="CREATE"
          role="ADMIN"
          onSaved={(s) => {
            setClientId(s.id);
            go("contact");
          }}
        />
      )}

      {/* Step 2: Create Contact for Client */}
      {step === "contact" && clientId && (
        <ContactDialog
          open
          onOpenChange={closeGuard("contact")}
          mode="CREATE"
          role="ADMIN"
          clientId={clientId}
          onSaved={() => {
            go("property");
          }}
        />
      )}

      {/* Step 3: Create Property for Client */}
      {step === "property" && (
        <PropertyDialog
          open
          onOpenChange={closeGuard("property")}
          mode="CREATE"
          role="ADMIN"
          defaultClientId={clientId ?? undefined}
          onSaved={(s) => {
            setPropertyId(s.id);
            go("job");
          }}
        />
      )}

      {/* Step 4: Create Job for Property */}
      {step === "job" && (
        <JobDialog
          open
          onOpenChange={closeGuard("job")}
          mode="CREATE"
          defaultPropertyId={propertyId ?? undefined}
          onSaved={(created) => {
            if (created?.id) {
              setJobId(created.id);
              setJobDefaults({
                defaultPrice: created.defaultPrice,
                notes: created.notes,
                frequencyDays: created.frequencyDays,
              });
              go("occurrence");
            } else {
              handleCancel();
            }
          }}
        />
      )}

      {/* Step 5: Create first Occurrence */}
      {step === "occurrence" && jobId && (
        <OccurrenceDialog
          open
          onOpenChange={closeGuard("occurrence")}
          mode="CREATE"
          jobId={jobId}
          defaultPrice={jobDefaults.defaultPrice}
          defaultNotes={jobDefaults.notes}
          title="New Occurrence (Final Step)"
          submitLabel="Create & Finish"
          onSaved={() => {
            reset();
            onDone();
          }}
        />
      )}
    </>
  );
}
