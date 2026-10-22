# Pantry and recipe plan

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

`pantry-plan` is an **Organize life** feature using only entered recipes and pantry quantities. No shopping, nutrition/allergen/food-safety guidance, generation, search, context read, notification or external action occurs.

Start `/nobo-help agent pantry-plan create Pasta | 2`. With its returned ID, add `ingredient ID add pasta | 200 | g`, then `stock ID | pasta | 0.3 | kg`. `plan ID | 4` shows **400 g needed, 300 g available, 100 g shopping gap**. Planning saves one current preview without consuming anything. Copy the complete returned `use ID PLAN_TOKEN confirm` command to consume available stock once. Missing stock remains unknown; explicit zero establishes a known gap.

Grammar after `/nobo-help agent pantry-plan`:

```text
create TITLE | BASE_SERVINGS
ingredient ID add NAME | QUANTITY | UNIT
ingredient ID edit INGREDIENT | NAME | QUANTITY | UNIT
ingredient ID remove INGREDIENT confirm
stock ID | NAME | QUANTITY | UNIT
pantry ID edit STOCK | NAME | QUANTITY | UNIT
pantry ID remove STOCK confirm
plan ID | TARGET_SERVINGS
preview ID [PAGE [rev TOKEN]]
use ID PLAN_TOKEN confirm
edit ID | title/baseServings | VALUE
clear ID title/baseServings/preview confirm
list [PAGE]
show ID [PAGE [rev TOKEN]]
export ID
delete ID [confirm]
help
```

Ingredient and pantry edit replace all accepted row fields; remove deletes the complete row. `stock` sets (not adds to) the compatible normalized pantry entry and preserves its stable ID. Pantry edit also resets current remaining stock to the explicitly entered amount. Ingredient edits, stock changes and recipe edits clear the current preview. Preview removal requires `confirm`. No old plans or hidden history remain. The exported original `quantity` remains available alongside current `remaining`; replacing that original amount is an explicit stock edit.

Names normalize by NFC, lowercase and collapsed whitespace, with no fuzzy/plural/substitution matching. Only `g/kg` and `ml/l` convert. Other lowercase ASCII unit labels, such as `each`, must match exactly. Weight never converts to volume. Same-name incompatible stock is flagged and excluded. Identical ingredient keys combine; every original ingredient ID remains in the plan.

Servings are integers 1–100; quantities 0–1,000,000 with at most three decimal places; title/name ≤160 UTF-8 bytes; units ≤24 lowercase ASCII letters/digits/hyphens beginning with a letter. Use `\|` for literal pipes and `\\` for backslashes. Extra fields and other escapes reject.

Calculations use an exact fixed integer coordinate: denominator `1000 × lcm(1..100)` in the base unit (g, ml, or the exact count unit). Every allowed serving ratio divides this scale, so repeated fractional use never accumulates rounding or an expanding denominator. Full `remaining` integer numerators are exposed in show/export; the denominator is defined here. Plan displays terminating values through three decimals when exact, otherwise reduced fractions, and consumes those exact fractions. Three one-serving uses of a one-gram, three-serving recipe consume exactly one gram. Available stock is reduced by `min(needed, available)`; insufficient/unknown inventory is never invented.

Schema 1: 12 recipes, 20 ingredient and 20 pantry rows per recipe, one current preview per recipe. New content ≤32,768 serialized UTF-8 bytes; complete state ≤49,152; each complete export envelope ≤24,576. Admission reserves the maximum preview token/fingerprint/servings and revision for every recipe; stock consumption can only shorten its bounded integer numerator. Explicit removal remains available at the revision ceiling. No cache, eviction, background work or retained superseded token exists.

Show/export expose all original and remaining fields. Preview/detail pages are lossless and carry revision plus content fingerprints. Preview tokens bind the canonical recipe and stock, are revalidated inside every CAS retry, and are cleared on use. Actual same-record CAS conflicts reject; unrelated records retry. Replayed/concurrent confirmation cannot double-consume. Malformed stored shapes preserve exact raw data; private owner/workspace scope is inherited from the runtime.

Verification: `node --import tsx --test --test-concurrency=1 tests/agent-pantry-plan.test.ts` under Node 24. The fake-backed tests cover worked arithmetic, units/unknowns, exact fractional repetition, all field/child lifecycle, twenty-row reconstruction, stale pages at revision ceiling, saturated content with successful preview/use, actual concurrent confirmation/edit/delete/unrelated CAS conflicts, strict corrupt shapes/raw preservation, isolation, and catalog metadata/help parity. Budgets are generation/search/context 0/0/0; logical reads/updates 8/4. This is not live integration or release approval.

At the 999,999,999 revision ceiling, only explicit removals continue; other writes require exporting and recreating the record. This prevents status/preview changes from cycling back to an indistinguishable snapshot when the injected clock has not advanced. Content saturation remains distinct: reserved lifecycle operations continue below the revision ceiling.
