import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

const requestSchema = z.object({
  topic: z.string().trim().min(2).max(300),
  languages: z.array(z.string().min(2).max(8)).min(1).max(6),
});
const resultSchema = z.object({
  results: z.array(z.object({
    german: z.string(),
    translations: z.record(z.string(), z.string()),
  })).length(200),
});

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const apiKey = process.env.OPENAI_API_KEY || process.env.AI_GATEWAY_API_KEY;
    const modelId = process.env.OPENAI_MODEL || process.env.AI_MODEL;
    if (!apiKey || !modelId) {
      return Response.json({ error: "Für Prozess A fehlt noch OPENAI_API_KEY und OPENAI_MODEL in der Umgebung." }, { status: 503 });
    }

    const provider = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
    const { object } = await generateObject({
      model: provider(modelId),
      schema: resultSchema,
      temperature: 0.8,
      prompt: `Du bist ein Spezialist für YouTube-Suchintentionen. Erstelle exakt 200 unterschiedliche, natürliche Suchanfragen zum Thema "${input.topic}". Schreibe jede Original-Suchanfrage auf Deutsch. Sie muss so klingen, wie ein echter Nutzer sie in die YouTube-Suche eingeben würde: konkrete Fragen, Vergleiche, Anleitungen, Erfahrungen, Fehler, Empfehlungen und aktuelle Aspekte. Keine Nummerierung, keine Duplikate, keine Hashtags und keine erfundenen Fakten. Übersetze danach jede Suchanfrage sinngemäß in diese Zielsprachen: ${input.languages.join(", ")}. Verwende in translations für jede Sprache exakt ihren Sprachcode als Schlüssel. Wenn Deutsch gewählt ist, ist die deutsche Fassung die Übersetzung unter "de".`,
    });
    return Response.json(object);
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Bitte gib ein Thema und mindestens eine Zielsprache an." }, { status: 400 });
    console.error("Process A failed", error);
    return Response.json({ error: "Die Generierung ist fehlgeschlagen. Prüfe Modell und API-Zugang." }, { status: 500 });
  }
}
