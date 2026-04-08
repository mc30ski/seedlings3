"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Input, Text } from "@chakra-ui/react";

type Suggestion = {
  id: string;
  place_name: string;
  center: [number, number]; // [lng, lat]
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  onValidated?: (validated: boolean) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  showValidation?: boolean;
};

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || "";

export default function AddressAutocomplete({
  value,
  onChange,
  onValidated,
  placeholder = "Start typing an address...",
  disabled,
  size = "sm",
  showValidation = false,
}: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [validated, setValidated] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const skipFetchRef = useRef(false);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (!query || query.length < 3 || !MAPBOX_TOKEN) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${MAPBOX_TOKEN}&country=us&types=address&limit=5`
      );
      if (res.ok) {
        const data = await res.json();
        setSuggestions(
          (data.features ?? []).map((f: any) => ({
            id: f.id,
            place_name: f.place_name,
            center: f.center,
          }))
        );
        setOpen(true);
      }
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  }, []);

  function handleInputChange(val: string) {
    onChange(val);
    setValidated(false);
    onValidated?.(false);
    if (skipFetchRef.current) {
      skipFetchRef.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(val), 300);
  }

  function selectSuggestion(s: Suggestion) {
    skipFetchRef.current = true;
    onChange(s.place_name);
    setSuggestions([]);
    setOpen(false);
    setValidated(true);
    onValidated?.(true);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  return (
    <Box ref={containerRef} position="relative" w="full">
      <Box position="relative">
        <Input
          size={size}
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          autoComplete="off"
          style={showValidation && validated ? { borderColor: "#38a169", paddingRight: "32px" } : undefined}
        />
        {showValidation && validated && (
          <span style={{
            position: "absolute",
            right: "10px",
            top: "50%",
            transform: "translateY(-50%)",
            color: "#38a169",
            fontSize: "16px",
            lineHeight: 1,
          }}>
            ✓
          </span>
        )}
      </Box>
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 9999,
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            marginTop: "2px",
            maxHeight: "200px",
            overflowY: "auto",
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s.id}
              onClick={() => selectSuggestion(s)}
              style={{
                padding: "8px 12px",
                fontSize: "13px",
                cursor: "pointer",
                borderBottom: "1px solid #f0f0f0",
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.backgroundColor = "#f7fafc"; }}
              onMouseLeave={(e) => { (e.currentTarget).style.backgroundColor = "#ffffff"; }}
            >
              {s.place_name}
            </div>
          ))}
        </div>
      )}
      {loading && (
        <Text fontSize="xs" color="fg.muted" mt={0.5}>Searching...</Text>
      )}
    </Box>
  );
}
