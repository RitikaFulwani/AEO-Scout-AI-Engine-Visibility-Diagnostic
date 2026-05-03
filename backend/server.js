

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("../frontend/public"));

// ── AI Client ─────────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "your_gemini_key_here") {
  console.error("❌ GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
console.log("✅ Gemini ready");

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(query) {
  return `A shopper asks: "${query}"

Please answer this as you normally would — recommend products, brands, or solutions that best answer the shopper's question. Be specific about brand names and product names where relevant. Give a helpful, natural response as if you are an AI shopping assistant.`;
}

// ── Brand / product extractor ─────────────────────────────────────────────────
function extractMentions(text) {
  const commonBrands = [
    "Nature Made", "Garden of Life", "Thorne", "Pure Encapsulations",
    "NOW Foods", "Solgar", "Life Extension", "MegaFood", "Rainbow Light",
    "Natrol", "Vitacost", "Kirkland", "Amazon Basics", "Centrum",
    "One A Day", "Nature's Bounty", "Spring Valley", "Zarbee's",
    "Nordic Naturals", "Jarrow", "Doctor's Best", "Country Life",
    "Bluebonnet", "New Chapter", "Designs for Health", "Ritual",
    "Seed", "Athletic Greens", "AG1", "Orgain", "Optimum Nutrition",
    "Ghost", "Legion", "Momentous", "Nutricost", "BulkSupplements",
  ];

  const mentions = [];
  const textLower = text.toLowerCase();

  for (const brand of commonBrands) {
    if (textLower.includes(brand.toLowerCase())) {
      const regex = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const count = (text.match(regex) || []).length;
      mentions.push({ brand, count, rank: mentions.length + 1 });
    }
  }

  const capPattern = /\b([A-Z][a-z]+ (?:[A-Z][a-z]+ )?(?:[A-Z][a-z]+)?)\b/g;
  const capMatches = [...text.matchAll(capPattern)];
  for (const match of capMatches) {
    const phrase = match[1].trim();
    if (
      phrase.split(" ").length >= 2 &&
      !mentions.find((m) => m.brand === phrase) &&
      !["The", "This", "These", "For", "If", "In", "It", "When", "You", "Your"].some((w) =>
        phrase.startsWith(w)
      )
    ) {
      mentions.push({ brand: phrase, count: 1, rank: mentions.length + 1 });
    }
  }

  return mentions.slice(0, 8);
}

function analyzeSentiment(text) {
  const positiveWords = ["recommend", "excellent", "best", "great", "quality", "effective", "top", "reliable", "trusted", "popular"];
  const negativeWords = ["avoid", "poor", "bad", "worst", "unreliable", "cheap", "inferior"];

  const textLower = text.toLowerCase();
  let score = 0;
  positiveWords.forEach((w) => { if (textLower.includes(w)) score++; });
  negativeWords.forEach((w) => { if (textLower.includes(w)) score--; });

  if (score > 2) return "Positive";
  if (score < 0) return "Negative";
  return "Neutral";
}

function scoreResponse(text, query, brandToTrack) {
  const textLower = text.toLowerCase();
  const queryWords = query.toLowerCase().split(" ").filter((w) => w.length > 3);

  let score = 0;
  const breakdown = [];

  const relevantWords = queryWords.filter((w) => textLower.includes(w));
  const relevanceScore = Math.min(30, Math.round((relevantWords.length / Math.max(queryWords.length, 1)) * 30));
  score += relevanceScore;
  breakdown.push({ label: "Relevance", score: relevanceScore, max: 30 });

  const brandMentioned = brandToTrack && textLower.includes(brandToTrack.toLowerCase());
  const brandScore = brandMentioned ? 40 : 0;
  score += brandScore;
  breakdown.push({ label: "Your Brand Mentioned", score: brandScore, max: 40 });

  const specificityScore = text.split(" ").length > 100 ? 20 : 10;
  score += specificityScore;
  breakdown.push({ label: "Answer Depth", score: specificityScore, max: 20 });

  const mentions = extractMentions(text);
  const brandPosition = mentions.findIndex(
    (m) => brandToTrack && m.brand.toLowerCase().includes(brandToTrack.toLowerCase())
  );
  const positionScore = brandPosition === 0 ? 10 : brandPosition === 1 ? 5 : 0;
  score += positionScore;
  breakdown.push({ label: "Ranking Position", score: positionScore, max: 10 });

  return { total: Math.min(100, score), breakdown };
}

// ── Query Gemini ──────────────────────────────────────────────────────────────
async function queryGemini(query, brandToTrack) {
  const prompt = buildPrompt(query);
  const start = Date.now();
  let text = "";
  let error = null;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const res = await model.generateContent(prompt);
    text = res.response.text();
  } catch (err) {
    error = err.message;
    text = `[Error querying Gemini: ${err.message}]`;
  }

  const latencyMs = Date.now() - start;
  const mentions = extractMentions(text);
  const sentiment = analyzeSentiment(text);
  const scores = scoreResponse(text, query, brandToTrack);

  return {
    model: "gemini",
    text,
    mentions,
    sentiment,
    scores,
    latencyMs,
    error,
    wordCount: text.split(" ").length,
  };
}

// ── Main endpoint ─────────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { query, brandToTrack } = req.body;

  if (!query || query.trim().length < 5) {
    return res.status(400).json({ error: "Query too short" });
  }

  try {
    const geminiResult = await queryGemini(query, brandToTrack);

    const results = {
      query,
      brandToTrack: brandToTrack || null,
      timestamp: new Date().toISOString(),
      availableModels: ["gemini"],
      models: {
        gemini: geminiResult,
      },
      aggregatedMentions: geminiResult.mentions
        .map((m) => ({ brand: m.brand, totalCount: m.count, models: ["gemini"] }))
        .sort((a, b) => b.totalCount - a.totalCount)
        .slice(0, 10),
    };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    availableModels: ["gemini"],
    keys: { gemini: true },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 AEO Diagnostic running on http://localhost:${PORT}`));