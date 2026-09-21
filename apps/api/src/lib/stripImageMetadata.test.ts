import { describe, it, expect } from "vitest";
import { stripImageMetadata } from "./stripImageMetadata";

/**
 * This is the only thing standing between a client's home coordinates and a
 * screen in a waiting room, so it is tested on the shapes that actually occur
 * rather than on a happy path.
 *
 * The stored original keeps its EXIF — that is evidence of when and where the
 * work happened. Only the copy served to a display is scrubbed.
 */

/** A JPEG is SOI, then length-prefixed segments, then SOS and entropy-coded
 *  data to EOI. Enough structure to exercise the walker without a fixture. */
function jpeg(segments: { marker: number; payload: Buffer }[], scan = Buffer.from([0x01, 0x02, 0x03])) {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const s of segments) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(s.payload.length + 2, 0);
    parts.push(Buffer.from([0xff, s.marker]), len, s.payload);
  }
  parts.push(Buffer.from([0xff, 0xda]), Buffer.from([0x00, 0x03, 0x00]), scan, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const exifPayload = Buffer.concat([
  Buffer.from("Exif\0\0", "ascii"),
  // Stand-in for the IFD carrying GPS tags.
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0xde, 0xad, 0xbe, 0xef]),
]);

describe("stripImageMetadata — JPEG", () => {
  it("removes the EXIF segment, which is where GPS lives", () => {
    const withExif = jpeg([
      { marker: 0xe0, payload: Buffer.from("JFIF\0", "ascii") },
      { marker: 0xe1, payload: exifPayload },
    ]);
    expect(withExif.includes(Buffer.from("Exif\0\0", "ascii"))).toBe(true);

    const { buffer, stripped } = stripImageMetadata(withExif, "image/jpeg");
    expect(stripped).toBe(true);
    expect(
      buffer.includes(Buffer.from("Exif\0\0", "ascii")),
      "the EXIF marker must be gone from the served copy",
    ).toBe(false);
    expect(
      buffer.includes(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
      "and so must its payload — dropping the header alone would leave the tags",
    ).toBe(false);
  });

  it("leaves the pixels byte-identical — no re-encode", () => {
    const scan = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const { buffer } = stripImageMetadata(
      jpeg([{ marker: 0xe1, payload: exifPayload }], scan),
      "image/jpeg",
    );
    expect(buffer.includes(scan), "the entropy-coded image data must survive untouched").toBe(true);
    expect(buffer.subarray(0, 2), "still a JPEG").toEqual(Buffer.from([0xff, 0xd8]));
    expect(buffer.subarray(-2), "still terminated").toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("keeps JFIF, which carries no identity and some decoders expect", () => {
    const { buffer } = stripImageMetadata(
      jpeg([{ marker: 0xe0, payload: Buffer.from("JFIF\0", "ascii") }]),
      "image/jpeg",
    );
    expect(buffer.includes(Buffer.from("JFIF\0", "ascii"))).toBe(true);
  });

  it("removes XMP and IPTC too — GPS is not only in EXIF", () => {
    const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>35.9N</x:xmpmeta>", "ascii");
    const iptc = Buffer.from("Photoshop 3.0\0somecaption", "ascii");
    const { buffer } = stripImageMetadata(
      jpeg([
        { marker: 0xe1, payload: xmp },
        { marker: 0xed, payload: iptc },
      ]),
      "image/jpeg",
    );
    expect(buffer.includes(Buffer.from("35.9N", "ascii"))).toBe(false);
    expect(buffer.includes(Buffer.from("somecaption", "ascii"))).toBe(false);
  });

  it("SNIFFS the format rather than trusting contentType", () => {
    // contentType is whatever the uploader claimed. A mislabelled JPEG that
    // sailed through untouched would be the quiet version of this bug.
    const { stripped, buffer } = stripImageMetadata(
      jpeg([{ marker: 0xe1, payload: exifPayload }]),
      "application/octet-stream",
    );
    expect(stripped).toBe(true);
    expect(buffer.includes(Buffer.from("Exif\0\0", "ascii"))).toBe(false);
  });

  it("reports stripped=false when there was nothing to remove", () => {
    const clean = jpeg([{ marker: 0xe0, payload: Buffer.from("JFIF\0", "ascii") }]);
    const { stripped, buffer } = stripImageMetadata(clean, "image/jpeg");
    expect(stripped).toBe(false);
    expect(buffer.equals(clean), "an untouched image must come back identical").toBe(true);
  });

  it("passes a format it does not understand through unchanged", () => {
    const weird = Buffer.from("RIFF....WEBPVP8 ", "ascii");
    const { buffer, stripped } = stripImageMetadata(weird, "image/webp");
    expect(stripped).toBe(false);
    expect(buffer.equals(weird)).toBe(true);
  });

  it("does not corrupt a truncated file", () => {
    const truncated = jpeg([{ marker: 0xe1, payload: exifPayload }]).subarray(0, 8);
    expect(() => stripImageMetadata(truncated, "image/jpeg")).not.toThrow();
  });
});

describe("stripImageMetadata — PNG", () => {
  function png(chunks: { type: string; data: Buffer }[]) {
    const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    for (const c of chunks) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(c.data.length, 0);
      parts.push(len, Buffer.from(c.type, "ascii"), c.data, Buffer.from([0, 0, 0, 0]));
    }
    return Buffer.concat(parts);
  }

  it("drops eXIf and text chunks, keeps image data", () => {
    const input = png([
      { type: "IHDR", data: Buffer.alloc(13) },
      { type: "eXIf", data: Buffer.from("GPSLAT35.9", "ascii") },
      { type: "tEXt", data: Buffer.from("Comment\0taken at home", "ascii") },
      { type: "IDAT", data: Buffer.from("PIXELS", "ascii") },
      { type: "IEND", data: Buffer.alloc(0) },
    ]);
    const { buffer, stripped } = stripImageMetadata(input, "image/png");
    expect(stripped).toBe(true);
    expect(buffer.includes(Buffer.from("GPSLAT35.9", "ascii"))).toBe(false);
    expect(buffer.includes(Buffer.from("taken at home", "ascii"))).toBe(false);
    expect(buffer.includes(Buffer.from("PIXELS", "ascii")), "image data survives").toBe(true);
    expect(buffer.includes(Buffer.from("IHDR", "ascii")), "header survives").toBe(true);
  });
});
