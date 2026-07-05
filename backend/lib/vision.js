import sharp from "sharp";

// Anthropic recommends capping the long edge around 1568px — larger images
// cost more tokens/latency without improving recognition quality, and phone
// photos routinely exceed the API's 5MB (post-base64) payload limit.
const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 85;

// Deliberately small and fixed for Phase 1 — proving the pipeline works
// end-to-end matters more than getting the taxonomy right. Phase 2 expands
// this into the full equipment/condition/activity vocabulary from the brief.
export const CATEGORIES = [
  "Water Sampling & Testing",
  "Plant Room & Pipework",
  "BMS & Controls",
  "Ductwork & Airflow",
  "Equipment & Plant",
  "Data Plate & Documentation",
  "Other",
];

export const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
]);

/**
 * Normalizes any supported input image into a size-capped JPEG so every
 * request is well under the API's payload limit regardless of source
 * (phone photos routinely arrive larger than that limit once base64-encoded).
 */
async function loadImageAsBase64(filePath) {
  const buffer = await sharp(filePath, { failOn: "none" })
    .rotate() // apply EXIF orientation before resizing
    .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return { data: buffer.toString("base64"), mediaType: "image/jpeg" };
}

const TOOL_NAME = "record_photo_analysis";

function buildTool() {
  return {
    name: TOOL_NAME,
    description: "Record the single caption and category for this site photo.",
    input_schema: {
      type: "object",
      properties: {
        caption: {
          type: "string",
          description:
            "One concise engineering caption describing exactly what's shown — include any legible labels, readings, or equipment identifiers visible in the photo.",
        },
        category: {
          type: "string",
          enum: CATEGORIES,
          description: "The single best-fit category for this photo.",
        },
      },
      required: ["caption", "category"],
    },
  };
}

const PROMPT = `You are looking at a site photo taken by a mechanical/water hygiene commissioning engineer. Call ${TOOL_NAME} with exactly one caption and exactly one category for this photo. Do not describe more than what is asked. If there is handwritten or printed text, a gauge reading, or a screen/display visible, include the literal text/value in the caption.`;

/**
 * Sends one photo to Claude vision and returns its caption + category.
 * Throws the raw SDK error on failure — callers must not swallow or
 * re-wrap it, per the Phase 1 requirement to see real errors.
 */
export async function analyzePhoto(client, model, filePath) {
  const { data, mediaType } = await loadImageAsBase64(filePath);

  const response = await client.messages.create({
    model,
    max_tokens: 300,
    tools: [buildTool()],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error(
      `No tool_use block in response (stop_reason: ${response.stop_reason}): ${JSON.stringify(response.content)}`
    );
  }

  return {
    caption: toolUse.input.caption,
    category: toolUse.input.category,
    usage: response.usage,
  };
}
