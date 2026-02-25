const { Mistral } = require("@mistralai/mistralai");

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
  }
  return _client;
}

const annotationFormat = {
  type: "json_schema",
  jsonSchema: {
    name: "receipt",
    schemaDefinition: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "The vendor or merchant name" },
        date: { type: "string", description: "The transaction date in MM/DD/YYYY format" },
        total: { type: "string", description: "The total amount including dollar sign, e.g. $12.34" },
      },
      required: ["vendor", "date", "total"],
      additionalProperties: false,
    },
    strict: true,
  },
};

/**
 * Analyzes a receipt image buffer using Mistral OCR with Annotations.
 * Returns { vendor, date, total }.
 */
async function analyzeReceiptImage(imageBuffer) {
  const client = getClient();
  const base64Image = imageBuffer.toString("base64");

  const ocrResponse = await client.ocr.process({
    model: "mistral-ocr-latest",
    document: {
      type: "image_url",
      imageUrl: "data:image/jpeg;base64," + base64Image,
    },
    documentAnnotationFormat: annotationFormat,
    documentAnnotationPrompt:
      "Extract the vendor/merchant name, transaction date, and total amount from this receipt.",
  });

  let annotation = ocrResponse.documentAnnotation;

  if (!annotation) {
    return { vendor: null, date: null, total: null };
  }

  if (typeof annotation === "string") {
    annotation = JSON.parse(annotation);
  }

  return {
    vendor: annotation.vendor || null,
    date: annotation.date || null,
    total: annotation.total || null,
  };
}

module.exports = { analyzeReceiptImage };
