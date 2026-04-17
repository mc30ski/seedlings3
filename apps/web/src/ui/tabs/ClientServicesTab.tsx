"use client";

import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, HStack, Text, VStack, Spinner } from "@chakra-ui/react";
import { ExternalLink, Mail } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";

type ClientJob = {
  id: string;
  kind: string;
  startAt?: string | null;
  property?: { displayName: string } | null;
  workers?: string[];
};

export default function ClientServicesTab() {
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await apiGet<any>("/api/client/me");
        if (me?.linked) {
          setLinked(true);
          const upcoming = await apiGet<{ items: any[] }>("/api/client/upcoming");
          if (upcoming?.items) setJobs(upcoming.items);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const kindLabel = (k: string) => {
    const map: Record<string, string> = {
      ENTIRE_SITE: "Full Property Service",
      SINGLE_ADDRESS: "Individual Service",
    };
    return map[k] ?? k;
  };

  return (
    <Box w="full" pb={8}>
      <Box p={5} bg="green.50" borderWidth="1px" borderColor="green.200" rounded="lg" mb={5}>
        <VStack gap={3} align="start">
          <Text fontSize="xl" fontWeight="bold" color="green.800">Our Services</Text>
          <Text fontSize="sm" color="green.700">
            Seedlings Lawn Care provides professional lawn maintenance, landscaping, and property care services.
            We'd love to help keep your property looking its best.
          </Text>
        </VStack>
      </Box>

      {/* Active services for linked clients */}
      {loading && (
        <Box py={6} textAlign="center"><Spinner size="md" /></Box>
      )}
      {!loading && linked && jobs.length > 0 && (
        <Box mb={5}>
          <Text fontSize="sm" fontWeight="semibold" color="green.800" mb={2} px={1}>
            Your Upcoming Services
          </Text>
          <VStack align="stretch" gap={2}>
            {jobs.map((job: any) => (
              <Card.Root key={job.id} variant="outline" borderColor="green.300">
                <Card.Body py="3" px="4">
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={0.5}>
                      <Text fontSize="sm" fontWeight="medium">{job.property?.displayName ?? "Property"}</Text>
                      <HStack gap={1}>
                        <Badge size="sm" colorPalette="green" variant="subtle">{kindLabel(job.kind)}</Badge>
                        {job.workers?.length > 0 && (
                          <Text fontSize="xs" color="fg.muted">with {job.workers.join(", ")}</Text>
                        )}
                      </HStack>
                    </VStack>
                    {job.startAt && (
                      <Text fontSize="xs" color="fg.muted" flexShrink={0}>{fmtDate(job.startAt)}</Text>
                    )}
                  </HStack>
                </Card.Body>
              </Card.Root>
            ))}
          </VStack>
        </Box>
      )}
      {!loading && linked && jobs.length === 0 && (
        <Box mb={5} p={3} bg="gray.50" rounded="md">
          <Text fontSize="sm" color="fg.muted" textAlign="center">No upcoming services scheduled.</Text>
        </Box>
      )}

      <Text fontSize="sm" fontWeight="semibold" color="green.800" mb={2} px={1}>
        What We Offer
      </Text>
      <VStack align="stretch" gap={3} mb={5}>
        {[
          { title: "Lawn Mowing & Maintenance", desc: "Weekly or biweekly mowing, edging, trimming, and blowing. We keep your lawn at the perfect height all season long." },
          { title: "Landscaping & Bed Maintenance", desc: "Mulching, weeding, flower bed design, and seasonal plantings to enhance your property's curb appeal." },
          { title: "Tree & Hedge Trimming", desc: "Professional pruning and shaping for trees, hedges, and shrubs. We handle small to medium jobs safely." },
          { title: "Leaf & Debris Cleanup", desc: "Seasonal cleanups to clear leaves, branches, and debris. Keeps your yard tidy year-round." },
          { title: "Aeration & Overseeding", desc: "Core aeration and overseeding to promote a thick, healthy lawn. Recommended annually in fall." },
        ].map((svc) => (
          <Card.Root key={svc.title} variant="outline" borderColor="green.200">
            <Card.Body py="3" px="4">
              <Text fontSize="sm" fontWeight="semibold" color="green.800">{svc.title}</Text>
              <Text fontSize="xs" color="green.700" mt={1}>{svc.desc}</Text>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>

      <Box p={4} bg="green.50" borderWidth="1px" borderColor="green.200" rounded="lg">
        <Text fontSize="md" fontWeight="semibold" color="green.800" mb={2}>Get in Touch</Text>
        <Text fontSize="sm" color="green.700" mb={3}>
          Interested in a quote or have questions? We'd love to hear from you.
        </Text>
        <HStack gap={3} wrap="wrap">
          <a href="https://www.seedlingslawncare.com/" target="_blank" rel="noopener noreferrer">
            <Button size="sm" colorPalette="green">
              <ExternalLink size={14} /> Visit Our Website
            </Button>
          </a>
          <a href="mailto:contact@seedlingslawncare.com?subject=Service%20Request">
            <Button size="sm" colorPalette="green" variant="outline">
              <Mail size={14} /> Email Us
            </Button>
          </a>
        </HStack>
      </Box>
    </Box>
  );
}
