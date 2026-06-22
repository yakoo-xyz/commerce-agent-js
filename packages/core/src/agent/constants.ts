export const FALLBACK_PRODUCT_ID = "0";

export const SCORING_STOPWORDS = new Set([
  "the", "a", "an", "for", "with", "from", "that", "this", "i", "me",
  "my", "looking", "find", "want", "need", "get", "finish",
  "buy", "also", "and", "in", "is", "it", "am", "im", "priced", "pesos",
  "php", "price", "between", "than", "above", "below", "more", "less",
  "over", "under", "of", "to", "or", "on", "at", "by", "its", "be", "can",
  "has", "have", "will", "would", "should", "item", "items", "both", "these",
  "offering", "sells", "shop", "budget", "voucher", "discount", "first", "second",
  "replacement", "suitable", "broken", "ballpoint", "repair", "use",
  "third", "brand", "made", "using", "available", "support", "supports", "compatible",
  "please", "tip", "age",
]);

export const REGEX_STOPWORDS = new Set([
  ...SCORING_STOPWORDS,
  "looking", "find", "want", "need", "get", "buy", "also", "and", "in", "is",
  "it", "am", "im", "priced", "pesos", "php", "price", "between", "than",
  "above", "below", "more", "less", "over", "under", "of", "to", "or", "on",
  "at", "by", "its", "be", "can", "has", "have", "will", "would", "should",
  "item", "items", "both", "these", "offering", "sells", "shop", "budget",
  "voucher", "discount", "first", "second", "third", "please", "tip", "age",
  "same", "from", "with",
  "must", "should", "would", "could", "may", "might", "shall", "being",
  "been", "was", "were", "are", "do", "does", "did", "done", "having",
  "had", "got", "make", "makes", "made", "take", "takes", "took", "taken",
  "give", "gives", "gave", "given", "put", "puts", "say", "says", "said",
  "tell", "tells", "told", "see", "sees", "saw", "seen", "know", "knows",
  "knew", "known", "think", "thinks", "thought", "come", "comes", "came",
  "go", "goes", "went", "gone", "look", "looks", "looked", "use", "uses",
  "used", "work", "works", "worked", "call", "calls", "called", "try",
  "tries", "tried", "ask", "asks", "asked", "seem", "seems", "seemed",
  "feel", "feels", "felt", "leave", "leaves", "left", "keep", "keeps",
  "kept", "let", "lets", "begin", "begins", "began", "show", "shows",
  "showed", "shown", "hear", "hears", "heard", "play", "plays", "played",
  "run", "runs", "ran", "move", "moves", "moved", "live", "lives", "lived",
  "believe", "believes", "believed", "bring", "brings", "brought", "happen",
  "happens", "happened", "write", "writes", "wrote", "written", "provide",
  "provides", "provided", "sit", "sits", "sat", "stand", "stands", "stood",
  "lose", "loses", "lost", "pay", "pays", "paid", "meet", "meets", "met",
  "include", "includes", "included", "continue", "continues", "continued",
  "set", "sets", "learn", "learns", "learned", "change", "changes", "changed",
  "lead", "leads", "led", "understand", "understands", "understood", "watch",
  "watches", "watched", "follow", "follows", "followed", "stop", "stops",
  "stopped", "create", "creates", "created", "speak", "speaks", "spoke",
  "spoken", "read", "reads", "allow", "allows", "allowed", "add", "adds",
  "added", "spend", "spends", "spent", "grow", "grows", "grew", "grown",
  "open", "opens", "opened", "walk", "walks", "walked", "win", "wins", "won",
  "offer", "offers", "offered", "remember", "remembers", "remembered", "love",
  "loves", "loved", "consider", "considers", "considered", "appear", "appears",
  "appeared", "wait", "waits", "waited", "serve", "serves", "served", "die",
  "dies", "died", "send", "sends", "sent", "expect", "expects", "expected",
  "build", "builds", "built", "stay", "stays", "stayed", "fall", "falls",
  "fell", "fallen", "cut", "cuts", "reach", "reaches", "reached", "kill",
  "kills", "killed", "remain", "remains", "remained", "suggest", "suggests",
  "suggested", "raise", "raises", "raised", "pass", "passes", "passed",
  "sell", "sells", "sold", "require", "requires", "required", "report",
  "reports", "reported", "decide", "decides", "decided", "pull", "pulls",
  "pulled", "return", "returns", "returned", "explain", "explains",
  "explained", "hope", "hopes", "hoped", "develop", "develops", "developed",
  "carry", "carries", "carried", "break", "breaks", "broke", "broken",
  "receive", "receives", "received", "agree", "agrees", "agreed", "support",
  "supports", "supported", "hit", "hits", "produce", "produces", "produced",
  "eat", "eats", "ate", "eaten", "cover", "covers", "covered", "catch",
  "catches", "caught", "draw", "draws", "drew", "drawn", "choose", "chooses",
  "chose", "chosen", "named", "called", "family", "belongs", "comes",
  "another", "lastly", "benefits", "you", "weighing", "capacity", "size",
  "sized", "eu", "fits",
]);

export const MULTI_PRODUCT_SPLIT_RE =
  /(?:,?\s*and\s+also\s+|,?\s*also,?\s*|Second(?:ly)?,\s*|Third(?:ly)?,\s*|First,\s*|\(\d+\)\s*|\d+\.\s*|Additionally,\s*|Furthermore,\s*|Moreover,\s*|In\s+addition,?\s*|Plus,\s*|On\s+top\s+of\s+that,?\s*|[.]\s*Next,\s*|[.]\s*Lastly,\s*|[.]\s*Finally,\s*|[.]\s*Last,\s*|\bThen\s*,?\s*I\s+(?:need|want|also)\b|\bI\s+also\s+(?:want|need)\b)/i;

export const BUDGET_SPLIT_RE = /(?:My budget|budget is|I have a voucher)/i;

/** Split a user query into per-product segments for multi-item requests. */
export function splitMultiProductQuery(query: string): string[] {
  const productText = query.split(BUDGET_SPLIT_RE)[0]?.trim() ?? query;

  const byMarkers = productText
    .split(MULTI_PRODUCT_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);
  if (byMarkers.length > 1) return byMarkers;

  const byAnd = productText
    .split(/\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);
  if (byAnd.length > 1 && byAnd.every((p) => p.split(/\s+/).length >= 2)) {
    return byAnd;
  }

  return [productText || query];
}

export const SHOP_SCORE_THRESHOLD = 6.0;
