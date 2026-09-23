import { generateText } from "ai";
import { z } from "zod";

const outputSchema = z.object({
  intent: z.enum(["ticket", "query", "brief"]),
  title: z.string().default(""),
  store: z.string().nullable().default(null),
  category: z.enum([
    "Maintenance",
    "Supplier / Stock",
    "IT / POS",
    "Marketing",
    "HR / Staff",
    "Finance",
    "Landlord / Centre",
    "Health & Safety",
    "Other"
  ]).default("Other"),
  priority: z.enum(["normal", "urgent"]).default("normal"),
  status: z.enum(["new", "waiting"]).default("new"),
  waiting_for: z.enum([
    "Supplier",
    "Landlord",
    "Contractor",
    "Staff",
    "Centre Management",
    "Other"
  ]).nullable().default(null),
  due_hint: z.string().nullable().default(null),
  follow_up_hint: z.string().nullable().default(null),
  summary: z.string().default(""),
  next_action: z.string().default("")
});

function extractJson(text) {
  const cleaned = text.trim().replace(/^\`\`\`json\s*/i, "").replace(/\`\`\`$/i, "").trim();
  return JSON.parse(cleaned);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const text = String(body.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  if (text.length > 12000) return res.status(413).json({ error: "Input too large" });

  const stores = Array.isArray(body.stores) ? body.stores.map(String).slice(0, 50) : [];
  const now = String(body.now || new Date().toISOString());

  const prompt = [
    "You are Hanok AI, the operations assistant for a multi-store restaurant group in Australia.",
    "Understand English, Chinese, and mixed-language operational notes.",
    "Convert the input into a concise operations interpretation.",
    "Never invent a store. store must be exactly one of the supplied store names or null.",
    "For waiting/follow-up language, use status=waiting and identify who/what is being waited on.",
    "Use urgent only for genuinely time-critical operational or safety issues.",
    "due_hint and follow_up_hint should be ISO-8601 datetime strings when the input gives enough timing information; otherwise null.",
    "Return JSON only, with no markdown.",
    "",
    "Current time: " + now,
    "Allowed stores: " + JSON.stringify(stores),
    "User input: " + text,
    "",
    "Required JSON keys:",
    JSON.stringify({
      intent: "ticket|query|brief",
      title: "short action-oriented title",
      store: "exact allowed store name or null",
      category: "one supported category",
      priority: "normal|urgent",
      status: "new|waiting",
      waiting_for: "Supplier|Landlord|Contractor|Staff|Centre Management|Other|null",
      due_hint: "ISO datetime or null",
      follow_up_hint: "ISO datetime or null",
      summary: "concise interpretation",
      next_action: "single best operational next action"
    })
  ].join("\n");

  try {
    const result = await generateText({
      model: "openai/gpt-5.4",
      prompt,
      providerOptions: {
        gateway: {
          tags: ["app:hanok-hq", "feature:analyze"]
        }
      }
    });

    const parsed = outputSchema.parse(extractJson(result.text));
    res.status(200).json({ ok: true, result: parsed, usage: result.usage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AI analysis failed" });
  }
}
