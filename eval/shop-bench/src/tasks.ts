export interface ShopTask {
  id: string;
  question: string;
  /** Substrings the context must contain when this task's knowledge is present. */
  facts: readonly string[];
}

const PLACES = 'relation customer places order';
export const EXCLUDE_CANCELLED_TEXT = 'Exclude cancelled orders.';
const EXCLUDE_CANCELLED = `constraint ${EXCLUDE_CANCELLED_TEXT}`;
const REVISE_EVIDENCE = 'evidence revise: fixture';

export const REFUND_SQL = 'SELECT 1 FROM refunds r JOIN orders o ON r.order_id = o.order_id';
export const NET_REVENUE = 'Net amount subtracts refunds.';
const REFUNDED_BY = 'relation order refunded_by refund';
const NOTE_EVIDENCE = `evidence trajectory: Agent note, shown by: ${REFUND_SQL}`;

/** Facts the seeded fixture already contains. */
export const BEFORE: readonly ShopTask[] = [
  {
    id: 'customer-order',
    question: 'Which customer places an order?',
    facts: [PLACES, EXCLUDE_CANCELLED, REVISE_EVIDENCE],
  },
];

/** Facts only a curator-accepted learning pass should add. */
export const AFTER: readonly ShopTask[] = [
  {
    id: 'refund-order',
    question: 'refund totals',
    facts: [REFUNDED_BY, `constraint ${NET_REVENUE}`, NOTE_EVIDENCE],
  },
];

export const TASKS: readonly ShopTask[] = [...BEFORE, ...AFTER];
