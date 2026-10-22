# Purchase cost comparison

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

**Organize life** feature `purchase-compare` compares only entered offers using a shared currency label and common usable unit. It does not fetch prices, convert currencies/units, infer tax/quality/resale, recommend guaranteed purchases, or take external action. Generation/search/context are all zero.

Start `/nobo-help agent purchase-compare create Filter packs | USD | filter | 12`. Enter `offer ID add Pack A | 24.00 | 3.00 | 0.00 | 6 | 0.00` and `offer ID add Pack B | 40.00 | 0.00 | 0.00 | 10 | 0.00`. `compare ID` ranks B's **(40 + 0 − 0)/10 = USD 4.00/filter** ahead of A's **(24 + 3 − 0)/6 = USD 4.50/filter**. `what-if ID | OFFER_A | shipping | 0.00` previews A at 4.00/filter without changing any stored bytes.

Grammar after `/nobo-help agent purchase-compare`:

```text
create TITLE | CURRENCY | COMMON_UNIT | HORIZON_MONTHS
offer ID add NAME | PRICE | SHIPPING | DISCOUNT | USABLE_QUANTITY | MONTHLY_RECURRING_COST
offer ID edit OFFER | FIELD | VALUE
offer ID clear OFFER FIELD confirm
offer ID remove OFFER confirm
compare ID [PAGE [rev TOKEN]]
what-if ID | OFFER | NUMERIC_FIELD | VALUE
edit ID | title/currency/unit/horizonMonths | VALUE
clear ID title/currency/unit/horizonMonths confirm
list [PAGE]
show ID [PAGE [rev TOKEN]]
export ID
delete ID [confirm]
help
```

Offer fields: `name`, `price`, `shipping`, `discount`, `usableQuantity`, `recurringCostPerMonth`, `lifeMonths`. Every field can be edited or explicitly cleared; remove deletes the entire offer. Numeric `unknown` and cleared values are missing, never zero. Root currency/unit changes explicitly relabel user-normalized inputs; they perform no exchange/unit conversion. All offers share that declared currency/unit. Extra per-offer currency/unit fields reject rather than silently rank incompatible inputs.

Amounts accept 0–1,000,000 with up to two decimals, stored as integer minor units (`priceMinor`, `shippingMinor`, `discountMinor`, `recurringMinorPerMonth`). Quantities are positive through 1,000,000 with up to three decimals, stored as `quantityMilli` thousandths of the common unit. Exponents, negative/zero quantity, excessive precision and discounts above a known price-plus-shipping subtotal reject. A discount with missing price/shipping leaves net cost unknown until the subtotal can be validated.

Net delivered cost is price + shipping − discount, before any unentered tax. Unit-cost ordering uses exact BigInt cross-products; displayed amounts round half up to 0.01 and can tie while exact ratios differ. Every result includes its formula, currency/unit and unknown fields. This ranks entered cost only, not utility or quality.

Horizon/life are 1–1,200 whole months. If life is supplied, horizon purchases are `ceil(horizon/life)`, buying the entire entered bundle at start and each expiration strictly before the horizon. Total is `net × purchases + monthly recurring × horizon`. It assumes the same entered costs for replacements and the entire bundle lasting that lifespan, without inferred demand, tax, resale or residual value. With unknown lifespan, replacement-aware horizon cost stays unknown; a separately labeled one-purchase scenario excludes replacements. Missing recurring cost or horizon prevents even that total. What-if modifies only one temporary offer and reports its formulas, without saving or changing other offers.

Titles/names ≤160 UTF-8 bytes, common unit ≤40, currency label ≤12 uppercase ASCII letters/digits starting with a letter. Use `\|`/`\\` for literal pipes/backslashes. Schema 1 has 12 comparisons and 8 offers each; new content ≤32,768, state ≤49,152, complete export envelope ≤24,576 serialized UTF-8 bytes. Revision growth is the entire remaining lifecycle reservation because calculations/what-if are unsaved. Explicit clear/remove/delete remains available at the revision ceiling; there is no hidden history or eviction.

Show pages reconstruct the exact export, including all original fields. Comparison/detail continuations bind revision plus content fingerprint. Same-record edit/deletion conflicts reject inside real CAS retries; unrelated record changes retry. Malformed state, including coerced number/currency arrays and invalid discounts, preserves exact raw bytes. Private workspace/user scope is enforced by the existing runtime/store.

Verification: ten tests via `node --import tsx --test --test-concurrency=1 tests/agent-purchase-compare.test.ts` under Node 24 cover the catalog arithmetic, unknown/zero values, exact/rounded large ratios, lifespan/horizon formulas, every root/offer field lifecycle, discount refusals, unsaved what-if, eight-offer and twelve-root limits, exact reconstruction/stale ceiling pages, saturated content, actual CAS edit/delete races, corrupt raw state, isolated owners and catalog metadata/help parity. Normal replies/help ≤3,500 units; resource budgets generation/search/context 0/0/0 and logical reads/updates 8/4. No live integration or release approval is implied.
