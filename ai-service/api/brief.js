import { generateText } from "ai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const context = req.body?.context;
  if (!context) return res.status(400).json({ error: "context is required" });

  const prompt = [
    "You are Hanok AI, an operations chief-of-staff for a restaurant group.",
    "Using only the supplied operational context, create a concise owner brief.",
    "Prioritise: urgent/overdue items, today's deadlines, waiting follow-ups, unassigned work, and project blockers.",
    "Do not invent facts.",
    "Output plain text with 3 sections: PRIORITIES, FOLLOW-UPS, WATCHLIST.",
    "Keep it under 220 words.",
    "",
    JSON.stringify(context)
  ].join("\n");

  try {
    const result = await generateText({
      model: "openai/gpt-5.4",
      prompt,
      providerOptions: {
        gateway: {
          tags: ["app:hanok-hq", "feature:brief"]
        }
      }
    });
    res.status(200).json({ ok: true, brief: result.text, usage: result.usage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AI brief failed" });
  }
}
