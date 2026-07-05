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

// From the build brief — expected to keep growing. The model is told to
// prefer these terms but isn't restricted to them (a JSON schema enum would
// silently force a bad fit whenever a photo shows something not yet listed).
export const EQUIPMENT_VOCABULARY = [
  "Air Handling Units",
  "MVHR Units",
  "FCUs",
  "Fans",
  "Diffusers",
  "Grilles",
  "Dampers",
  "Fire Dampers",
  "Pumps",
  "Plate Heat Exchangers",
  "Expansion Vessels",
  "Buffer Vessels",
  "Calorifiers",
  "Cold Water Storage Tanks",
  "RPZ Valves",
  "PRVs",
  "Balancing Valves",
  "Sensors",
  "BMS Controllers",
  "Sample Points",
  "Water Tanks",
  "Pipework",
  "Filters",
  "Heat Pumps",
  "Pressurisation Units",
  // Dedicated water treatment tag vocabulary — the brief calls for water
  // sampling/flushing/dosing to get first-class treatment, not be lumped in
  // as generic equipment shots.
  "Dosing Point",
  "TMV",
  "Calorifier Outlet",
  "Cold Water Outlet",
  "Shower Head",
  "Tap Outlet",
  "Flush Point",
];

// From the build brief — the standard activity list plus the dedicated
// work types called out for first-class treatment (Chemical Dosing).
// Closed set like conditions: strict enum for consistent filtering.
export const ACTIVITIES = [
  "Commissioning",
  "Flushing",
  "Water Sampling",
  "Legionella Sampling",
  "Disinfection/Chlorination",
  "Chemical Dosing",
  "Temperature Testing",
  "Pressure Testing",
  "Inspection",
  "Installation",
  "Fault Finding",
];

// From the build brief — a closed, specific set (unlike equipment), so it's
// enforced as a strict enum: consistent condition tags matter more for
// filtering/search than accommodating an unanticipated term here.
export const CONDITION_TAGS = [
  "Clean",
  "Dirty",
  "Corroded",
  "Leaking",
  "Damaged",
  "Good Condition",
  "Missing Insulation",
  "Missing Label",
  "Poor Access",
  "Before",
  "After",
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
    description: "Record the caption, category, equipment, condition tags, and activity for this site photo.",
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
        equipment: {
          type: "array",
          items: { type: "string" },
          description:
            "Distinct pieces of equipment visibly identifiable in the photo (0-6 items). Prefer standard terms (e.g. Pumps, BMS Controllers, Cold Water Storage Tanks) but use a concise engineering term for anything not on the standard list. Empty array if no specific equipment is identifiable.",
        },
        conditions: {
          type: "array",
          items: { type: "string", enum: CONDITION_TAGS },
          description:
            "Only conditions clearly visible in the photo itself — do not guess. Empty array if nothing notable applies. 'Before'/'After' only if the photo is explicitly labelled or captioned as such by the engineer; never infer it.",
        },
        activities: {
          type: "array",
          items: { type: "string", enum: ACTIVITIES },
          description:
            "The commissioning/water-hygiene work activity the photo depicts, if identifiable from visual context (e.g. a sample bottle implies Water Sampling, a dip test in a tank implies Inspection). 0-2 items. Empty array if the photo doesn't clearly depict a specific activity (e.g. a bare data plate or equipment shot).",
        },
      },
      required: ["caption", "category", "equipment", "conditions", "activities"],
    },
  };
}

const PROMPT = `You are looking at a site photo taken by a mechanical/water hygiene commissioning engineer. Call ${TOOL_NAME} with exactly one caption, exactly one category, the equipment visible, any condition tags that clearly apply, and the work activity depicted if identifiable. Do not describe more than what is asked. If there is handwritten or printed text, a gauge reading, or a screen/display visible, include the literal text/value in the caption.

Standard equipment vocabulary (prefer these terms when they fit, but don't force a bad fit): ${EQUIPMENT_VOCABULARY.join(", ")}.

Condition tags (only apply what's clearly visible, leave empty if nothing notable): ${CONDITION_TAGS.join(", ")}.

Activities (only apply if the photo clearly depicts one, leave empty otherwise): ${ACTIVITIES.join(", ")}.`;

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
    equipment: toolUse.input.equipment,
    conditions: toolUse.input.conditions,
    activities: toolUse.input.activities,
    usage: response.usage,
  };
}
