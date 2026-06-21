const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function testOCR() {
  try {
    console.log("Testing Gemini PDF OCR with a mock 1-page PDF buffer...");
    const mockPdfBase64 = "JVBERi0xLjQKMSAwIG9iagogIDw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iagogIDw8IC9UeXBlIC9QYWdlcyAvS2lkcyBbIDMgMCBSIF0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKICA8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0gPj4KZW5kb2JqCnRyYWlsZXIKICA8PCAvUm9vdCAxIDAgUiA+PgolJUVPRg==";
    const fileBuffer = Buffer.from(mockPdfBase64, "base64");

    const response = await model.generateContent([
      {
        inlineData: {
          data: fileBuffer.toString("base64"),
          mimeType: "application/pdf"
        }
      },
      "Extract and transcribe all text from this scanned document."
    ]);
    console.log("SUCCESS! Response text:", response.response.text());
  } catch (err) {
    console.error("FAILED! Error details:");
    console.error("Name:", err.name);
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);
  }
}

testOCR();
