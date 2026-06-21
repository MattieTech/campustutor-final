require("dotenv").config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY");
  process.exit(1);
}

async function testOpenRouterOCR() {
  try {
    console.log("Testing OpenRouter PPTX processing with a mock base64 PPTX...");
    // A tiny mock ZIP/PPTX base64 string
    const mockPptxBase64 = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=="; 
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${mockPptxBase64}`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract and transcribe all text from this presentation."
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `OpenRouter error: ${response.status}`);
    }

    console.log("SUCCESS! Response content:", data.choices[0].message.content);
  } catch (err) {
    console.error("FAILED! Error details:", err.message);
  }
}

testOpenRouterOCR();


