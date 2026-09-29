/**
 * Tokens that a constraint must mention to preserve each rule in answer/README.md
 * ("Constraints that preserve these rules"). Wording may differ; these facts may not.
 * Each inner list holds alternatives; every inner list must match.
 */
export const CONSTRAINT_RULES: ReadonlyMap<string, readonly (readonly string[])[]> = new Map([
  ['use_main_marts', [['raw'], ['cents', 'cent'], ['100']]],
  ['order_total_identity', [['order_total'], ['subtotal'], ['tax_paid']]],
  ['order_items_subtotal_identity', [['order_items_subtotal'], ['subtotal']]],
  [
    'lifetime_spend_identity',
    [['lifetime_spend'], ['lifetime_spend_pretax'], ['lifetime_tax_paid']],
  ],
  [
    'product_type_vocabulary',
    [['product_type'], ['jaffle'], ['beverage'], ['is_food_item'], ['is_drink_item']],
  ],
  ['customer_type_status', [['customer_type'], ['new'], ['returning'], ['count_lifetime_orders']]],
  [
    'supply_cost_no_double_count',
    [['supply_cost'], ['order_cost'], ['double', 'again', 'twice', 'already']],
  ],
  ['calendar_spine_not_events', [['2000-01-01'], ['2029-12-31']]],
]);

function mentions(text: string, token: string): boolean {
  const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- tokens are the fixed list above
  return new RegExp(String.raw`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, 'i').test(text);
}

export function satisfiesRule(text: string, rule: readonly (readonly string[])[]): boolean {
  return rule.every((alternatives) => alternatives.some((token) => mentions(text, token)));
}
