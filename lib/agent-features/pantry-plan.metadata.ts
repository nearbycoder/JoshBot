import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "pantry-plan",
  "title": "Pantry and recipe plan",
  "description": "Scale a saved recipe, subtract compatible pantry quantities, and produce an honest shopping gap list.",
  "group": "Organize life",
  "keywords": [
    "meal plan",
    "recipe",
    "pantry",
    "shopping list"
  ],
  "example": "/nobo-help agent pantry-plan create Pasta | 2",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Pantry and recipe plan — scale entered recipes and subtract compatible stock.\nStart: /nobo-help agent pantry-plan create Pasta | 2\ncreate TITLE | BASE_SERVINGS\ningredient ID add NAME | QUANTITY | UNIT\ningredient ID edit INGREDIENT | NAME | QUANTITY | UNIT\ningredient ID remove INGREDIENT confirm\nstock ID | NAME | QUANTITY | UNIT\npantry ID edit STOCK | NAME | QUANTITY | UNIT\npantry ID remove STOCK confirm\nplan ID | TARGET_SERVINGS\npreview ID [PAGE [rev TOKEN]]\nuse ID PLAN_TOKEN confirm\nedit ID | title/baseServings | VALUE\nclear ID title/baseServings/preview confirm\nlist [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID [confirm]; help\nCopy full returned IDs/tokens. A plan previews only; its fresh token consumes available stock once on explicit confirmation. Recipe/stock changes invalidate it. stock and pantry edit replace current stock, keeping the original quantity and exact remaining amount visible. Removal deletes the entire ingredient/pantry row. No retained prior plans.\nNames normalize by NFC, lowercase and collapsed spaces; only exact normalized names combine. Units: lowercase ASCII labels <=24 bytes; only g/kg and ml/l convert, all other count units must match exactly. No density, substitutions or plural inference. Unknown stock differs from entered zero; incompatible units remain separate and flagged.\nServings 1–100 integer; quantities 0–1000000 with <=3 decimals; titles/names <=160 UTF-8 bytes. Arithmetic retains exact fractions, never rounded consumption. Escape literal pipes as \\| and backslashes as \\\\.\n12 recipes; 20 ingredients and 20 pantry rows each; one preview per recipe. New content <=32768, state <=49152, export <=24576 UTF-8 bytes. Preview/revision space is reserved at admission. Delete explicitly to free space.\nPrivate/on demand. No model, search, context, shopping, nutrition, allergen or food-safety advice, notifications or external action."
} satisfies AgentFeatureMetadata;
