"use client";

import { Badge, Box, Button, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { ExternalLink, Mail, Phone } from "lucide-react";

export default function ClientServicesTab() {
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

      <VStack align="stretch" gap={3} mb={5}>
        {[
          { title: "Lawn Mowing & Maintenance", desc: "Weekly or biweekly mowing, edging, trimming, and blowing. We keep your lawn at the perfect height all season long." },
          { title: "Landscaping & Bed Maintenance", desc: "Mulching, weeding, flower bed design, and seasonal plantings to enhance your property's curb appeal." },
          { title: "Tree & Hedge Trimming", desc: "Professional pruning and shaping for trees, hedges, and shrubs. We handle small to medium jobs safely." },
          { title: "Leaf & Debris Cleanup", desc: "Seasonal cleanups to clear leaves, branches, and debris. Keeps your yard tidy year-round." },
          { title: "Aeration & Overseeding", desc: "Core aeration and overseeding to promote a thick, healthy lawn. Recommended annually in fall." },
          { title: "Pressure Washing", desc: "Driveways, walkways, patios, and siding. We'll make your hardscapes look brand new." },
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
          <a href="mailto:seedlings@wanderski.com?subject=Service%20Request">
            <Button size="sm" colorPalette="green" variant="outline">
              <Mail size={14} /> Email Us
            </Button>
          </a>
        </HStack>
      </Box>
    </Box>
  );
}
