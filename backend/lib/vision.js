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
        visibleText: {
          type: "array",
          items: { type: "string" },
          description:
            "Every distinct piece of legible text in the photo transcribed verbatim as separate items — asset/plant labels, handwritten notes, serials, model numbers, gauge/meter readings, controller/screen lines. One item per distinct label or line, not one big blob. Empty array if nothing legible.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "5-12 natural-language search terms an engineer might type to find this photo later — synonyms and colloquial phrasing, not a repeat of the structured tags above (e.g. 'water tank' not 'Cold Water Storage Tanks', 'biofilm', 'scale buildup', 'leak', 'fault alarm'). Lowercase, no duplicates of each other.",
        },
      },
      required: ["caption", "category", "equipment", "conditions", "activities", "visibleText", "keywords"],
    },
  };
}

const PROMPT = `You are looking at a site photo taken by a mechanical/water hygiene commissioning engineer. Call ${TOOL_NAME} with exactly one caption, exactly one category, the equipment visible, any condition tags that clearly apply, the work activity depicted if identifiable, every distinct piece of legible text transcribed verbatim, and natural-language search keywords. Do not describe more than what is asked.

Standard equipment vocabulary (prefer these terms when they fit, but don't force a bad fit): ${EQUIPMENT_VOCABULARY.join(", ")}.

Condition tags (only apply what's clearly visible, leave empty if nothing notable): ${CONDITION_TAGS.join(", ")}.

Activities (only apply if the photo clearly depicts one, leave empty otherwise): ${ACTIVITIES.join(", ")}.`;

// A JSON schema enum on a tool_use field is a strong instruction to Claude,
// not an API-enforced constraint — it can still occasionally emit a value
// outside the list (observed: "Wet" for conditions, not in CONDITION_TAGS).
// Silently keeping an out-of-vocabulary tag would corrupt tag-based search
// filters downstream, so every enum field is sanitized after the call.
function sanitizeEnumArray(values, allowed) {
  const allowedSet = new Set(allowed);
  const valid = [];
  const dropped = [];
  for (const v of Array.isArray(values) ? values : []) {
    (allowedSet.has(v) ? valid : dropped).push(v);
  }
  return { valid, dropped };
}

function sanitizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? { valid: value, dropped: null } : { valid: fallback, dropped: value };
}

/**
 * Sends one photo to Claude vision and returns its caption + category.
 * Throws the raw SDK error on failure — callers must not swallow or
 * re-wrap it, per the Phase 1 requirement to see real errors.
 */
export async function analyzePhoto(client, model, filePath) {
  const { data, mediaType } = await loadImageAsBase64(filePath);

  const response = await client.messages.create({
    model,
    max_tokens: 700,
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

  const category = sanitizeEnum(toolUse.input.category, CATEGORIES, "Other");
  const conditions = sanitizeEnumArray(toolUse.input.conditions, CONDITION_TAGS);
  const activities = sanitizeEnumArray(toolUse.input.activities, ACTIVITIES);
  const droppedTags = [category.dropped, ...conditions.dropped, ...activities.dropped].filter(Boolean);

  return {
    caption: toolUse.input.caption,
    category: category.valid,
    equipment: toolUse.input.equipment,
    conditions: conditions.valid,
    activities: activities.valid,
    droppedTags,
    visibleText: toolUse.input.visibleText,
    keywords: toolUse.input.keywords,
    usage: response.usage,
  };
}
