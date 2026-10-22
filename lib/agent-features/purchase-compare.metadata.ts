import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "purchase-compare",
  "title": "Purchase cost comparison",
  "description": "Compare entered offers by usable quantity, delivered cost, and transparent ownership assumptions.",
  "group": "Organize life",
  "keywords": [
    "unit price",
    "total cost",
    "offers",
    "purchase comparison"
  ],
  "example": "/nobo-help agent purchase-compare create Filter packs | USD | filter | 12",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Purchase cost comparison — entered delivered cost per common usable unit and explicit horizon assumptions.\nStart: /nobo-help agent purchase-compare create Filter packs | USD | filter | 12\ncreate TITLE | CURRENCY | COMMON_UNIT | HORIZON_MONTHS\noffer ID add NAME | PRICE | SHIPPING | DISCOUNT | USABLE_QUANTITY | MONTHLY_RECURRING_COST\noffer ID edit OFFER | FIELD | VALUE\noffer ID clear OFFER FIELD confirm\noffer ID remove OFFER confirm\nOffer fields: name, price, shipping, discount, usableQuantity, recurringCostPerMonth, lifeMonths. Numeric unknown means missing, never zero; clear removes a field. Lifespan defaults to unknown.\ncompare ID [PAGE [rev TOKEN]]\nwhat-if ID | OFFER | NUMERIC_FIELD | VALUE (unsaved, one offer only)\nedit ID | title/currency/unit/horizonMonths | VALUE\nclear ID title/currency/unit/horizonMonths confirm\nlist [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID [confirm]; help\nUse full returned IDs. Currencies/common units must be user-normalized before entry; no conversions. Root currency/unit edits explicitly relabel all inputs, without exchange/unit arithmetic.\nNet = price + shipping - discount. Rank exact net/usable quantity; show half-up rounding to0.01. Quantity must be positive; discounts cannot exceed known price+shipping. Missing fields stay unknown.\nHorizon with supplied lifeMonths: ceil(horizon/life) purchases of the whole bundle, same entered costs each time, plus recurring cost times horizon. Without lifespan, replacement-aware cost is unknown; a separately labeled single-purchase scenario excludes replacements. No demand, tax, quality or resale inferred.\nMoney 0–1000000 with <=2 decimals; quantities >0–1000000 with <=3 decimals; horizon/life 1–1200 integer months. Currency uppercase ASCII label <=12; unit <=40, title/name <=160 UTF-8 bytes. Literal | and backslash use \\| and \\\\.\n12 comparisons, 8 offers each. New content <=32768, state <=49152, complete export <=24576 UTF-8 bytes; byte limits can bind first. Revision growth reserved. Delete explicitly to free space.\nPrivate/on demand; zero model/search/context. No live prices, purchasing, notifications or external actions."
} satisfies AgentFeatureMetadata;
