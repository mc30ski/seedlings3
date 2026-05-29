"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Persistent file input that lives at document.body level so it survives
 * parent re-renders (card collapse, dialog teardown, etc.). iOS Safari/PWA
 * is unreliable with ephemeral `document.createElement("input")` pickers —
 * change events sometimes never fire, especially on multi-select. Mounting
 * the input once and reusing it avoids that whole class of failures.
 */
export function useFileUpload(onFiles: (files: FileList) => void) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        onFiles(input.files);
      }
      input.value = "";
    });
    document.body.appendChild(input);
    inputRef.current = input;
    return () => {
      document.body.removeChild(input);
      inputRef.current = null;
    };
  }, [onFiles]);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return openPicker;
}
